import type { BinaryStreamOf } from './app-render'
import type { Readable } from 'node:stream'
import type { ModelChannel } from 'react-server-dom-webpack/client'

import {
  htmlEscapeAttributeString,
  htmlEscapeJsonString,
} from '../../shared/lib/htmlescape'
import { workUnitAsyncStorage } from './work-unit-async-storage.external'
import { InvariantError } from '../../shared/lib/invariant-error'
import { getClientReferenceManifest } from './manifests-singleton'

const isEdgeRuntime = process.env.NEXT_RUNTIME === 'edge'

const INLINE_FLIGHT_PAYLOAD_BOOTSTRAP = 0
const INLINE_FLIGHT_PAYLOAD_DATA = 1
const INLINE_FLIGHT_PAYLOAD_FORM_STATE = 2
const INLINE_FLIGHT_PAYLOAD_BINARY = 3

const flightResponses = new WeakMap<
  Readable | BinaryStreamOf<any> | ModelChannel,
  Promise<any>
>()
const encoder = new TextEncoder()

const findSourceMapURL =
  process.env.NODE_ENV !== 'production'
    ? (require('../lib/source-maps') as typeof import('../lib/source-maps'))
        .findSourceMapURLDEV
    : undefined

/**
 * Render Flight stream.
 * This is only used for renderToHTML, the Flight response does not need additional wrappers.
 */
export function getFlightStream<T>(
  flightStream: Readable | BinaryStreamOf<T>,
  debugStream: Readable | ReadableStream<Uint8Array> | undefined,
  debugEndTime: number | undefined,
  nonce: string | undefined
): Promise<T> {
  const response = flightResponses.get(flightStream)

  if (response) {
    return response
  }

  const { moduleLoading, edgeSSRModuleMapping, ssrModuleMapping } =
    getClientReferenceManifest()

  let newResponse: Promise<T>
  if (flightStream instanceof ReadableStream) {
    // The types of flightStream and debugStream should match.
    if (debugStream && !(debugStream instanceof ReadableStream)) {
      throw new InvariantError('Expected debug stream to be a ReadableStream')
    }

    // react-server-dom-webpack/client.edge must not be hoisted for require cache clearing to work correctly
    const { createFromReadableStream } =
      // eslint-disable-next-line import/no-extraneous-dependencies
      require('react-server-dom-webpack/client') as typeof import('react-server-dom-webpack/client')

    newResponse = createFromReadableStream<T>(flightStream, {
      findSourceMapURL,
      serverConsumerManifest: {
        moduleLoading,
        moduleMap: isEdgeRuntime ? edgeSSRModuleMapping : ssrModuleMapping,
        serverModuleMap: null,
      },
      nonce,
      debugChannel: debugStream ? { readable: debugStream } : undefined,
      endTime: debugEndTime,
    })
  } else {
    if (process.env.NEXT_RUNTIME === 'edge') {
      throw new InvariantError(
        'getFlightStream should always receive a ReadableStream when using the edge runtime'
      )
    } else {
      const { Readable } =
        require('node:stream') as typeof import('node:stream')

      // Convert debug stream to Readable if it's a ReadableStream.
      // When __NEXT_USE_NODE_STREAMS is enabled, the debug channel produces
      // Node Readables natively. Otherwise, it produces web ReadableStreams.
      let nodeDebugStream: Readable | undefined
      if (debugStream) {
        if (debugStream instanceof Readable) {
          nodeDebugStream = debugStream
        } else {
          type WebReadableStream = import('stream/web').ReadableStream
          nodeDebugStream = Readable.fromWeb(debugStream as WebReadableStream)
        }
      }

      // react-server-dom-webpack/client.edge must not be hoisted for require cache clearing to work correctly
      const { createFromNodeStream } =
        // eslint-disable-next-line import/no-extraneous-dependencies
        require('react-server-dom-webpack/client') as typeof import('react-server-dom-webpack/client')

      newResponse = createFromNodeStream<T>(
        flightStream,
        {
          moduleLoading,
          moduleMap: isEdgeRuntime ? edgeSSRModuleMapping : ssrModuleMapping,
          serverModuleMap: null,
        },
        {
          findSourceMapURL,
          nonce,
          debugChannel: nodeDebugStream,
          endTime: debugEndTime,
        }
      )
    }
  }

  return cacheFlightResponse(flightStream, newResponse)
}

/**
 * Consume Flight rows delivered in object form over a ModelChannel instead of
 * parsing a teed copy of the RSC byte stream. Only supported in the Node.js
 * runtime. The channel must have been passed as the `modelChannel` option to
 * the Flight server render that produces this response.
 */
export function getFlightResponseFromModelChannel<T>(
  channel: ModelChannel,
  debugStream: Readable | ReadableStream<Uint8Array> | undefined,
  debugEndTime: number | undefined,
  nonce: string | undefined
): Promise<T> {
  const response = flightResponses.get(channel)

  if (response) {
    return response
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    throw new InvariantError(
      'getFlightResponseFromModelChannel is only supported in the Node.js runtime'
    )
  }

  if (process.env.NEXT_FLIGHT_MODEL_CHANNEL_DEBUG) {
    console.error(
      '[model-channel] SSR consuming Flight rows via ModelChannel (pid %d)',
      process.pid
    )
  }

  const { moduleLoading, ssrModuleMapping } = getClientReferenceManifest()

  // createFromModelChannel shares the edge client implementation, so the
  // debug channel must be a web ReadableStream even in the Node.js runtime.
  let webDebugStream: ReadableStream<Uint8Array> | undefined
  if (debugStream) {
    if (debugStream instanceof ReadableStream) {
      webDebugStream = debugStream
    } else {
      const { Readable } =
        require('node:stream') as typeof import('node:stream')
      webDebugStream = Readable.toWeb(debugStream) as ReadableStream<Uint8Array>
    }
  }

  // react-server-dom-webpack/client must not be hoisted for require cache clearing to work correctly
  const { createFromModelChannel } =
    // eslint-disable-next-line import/no-extraneous-dependencies
    require('react-server-dom-webpack/client') as typeof import('react-server-dom-webpack/client')

  const newResponse = createFromModelChannel<T>(channel, {
    findSourceMapURL,
    serverConsumerManifest: {
      moduleLoading,
      moduleMap: ssrModuleMapping,
      serverModuleMap: null,
    },
    nonce,
    debugChannel: webDebugStream ? { readable: webDebugStream } : undefined,
    endTime: debugEndTime,
  })

  return cacheFlightResponse(channel, newResponse)
}

function cacheFlightResponse<T>(
  key: Readable | BinaryStreamOf<any> | ModelChannel,
  newResponse: Promise<T>
): Promise<T> {
  // Edge pages are never prerendered so they necessarily cannot have a workUnitStore type
  // that requires the nextTick behavior. This is why it is safe to access a node only API here
  if (process.env.NEXT_RUNTIME !== 'edge') {
    const workUnitStore = workUnitAsyncStorage.getStore()

    if (!workUnitStore) {
      throw new InvariantError('Expected workUnitAsyncStorage to have a store.')
    }

    switch (workUnitStore.type) {
      case 'prerender-client':
      case 'validation-client':
        const responseOnNextTick = new Promise<T>((resolve) => {
          process.nextTick(() => {
            resolve(newResponse)
          })
        })
        flightResponses.set(key, responseOnNextTick)
        return responseOnNextTick
      case 'prerender':
      case 'prerender-runtime':
      case 'prerender-ppr':
      case 'prerender-legacy':
      case 'request':
      case 'cache':
      case 'private-cache':
      case 'unstable-cache':
      case 'generate-static-params':
        break
      default:
        workUnitStore satisfies never
    }
  }

  flightResponses.set(key, newResponse)

  return newResponse
}

/**
 * Creates a ReadableStream provides inline script tag chunks for writing hydration
 * data to the client outside the React render itself.
 *
 * @param flightStream The RSC render stream
 * @param nonce optionally a nonce used during this particular render
 * @param formState optionally the formState used with this particular render
 * @returns a ReadableStream without the complete property. This signifies a lazy ReadableStream
 */
export function createInlinedDataReadableStream(
  flightStream: ReadableStream<Uint8Array>,
  nonce: string | undefined,
  formState: unknown | null
): ReadableStream<Uint8Array> {
  const startScriptTag = nonce
    ? `<script nonce="${htmlEscapeAttributeString(nonce)}">`
    : '<script>'

  const flightReader = flightStream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })

  const readable = new ReadableStream({
    type: 'bytes',
    start(controller) {
      try {
        writeInitialInstructions(controller, startScriptTag, formState)
      } catch (error) {
        // during encoding or enqueueing forward the error downstream
        controller.error(error)
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await flightReader.read()

        if (value) {
          try {
            const decodedString = decoder.decode(value, { stream: !done })

            // The chunk cannot be decoded as valid UTF-8 string as it might
            // have arbitrary binary data.
            writeFlightDataInstruction(
              controller,
              startScriptTag,
              decodedString
            )
          } catch {
            // The chunk cannot be decoded as valid UTF-8 string.
            writeFlightDataInstruction(controller, startScriptTag, value)
          }
        }

        if (done) {
          controller.close()
        }
      } catch (error) {
        // There was a problem in the upstream reader or during decoding or enqueuing
        // forward the error downstream
        controller.error(error)
      }
    },
  })

  return readable
}

function writeInitialInstructions(
  controller: ReadableStreamDefaultController,
  scriptStart: string,
  formState: unknown | null
) {
  let scriptContents = `(self.__next_f=self.__next_f||[]).push(${htmlEscapeJsonString(
    JSON.stringify([INLINE_FLIGHT_PAYLOAD_BOOTSTRAP])
  )})`

  if (formState != null) {
    scriptContents += `;self.__next_f.push(${htmlEscapeJsonString(
      JSON.stringify([INLINE_FLIGHT_PAYLOAD_FORM_STATE, formState])
    )})`
  }

  controller.enqueue(encoder.encode(`${scriptStart}${scriptContents}</script>`))
}

function writeFlightDataInstruction(
  controller: ReadableStreamDefaultController,
  scriptStart: string,
  chunk: string | Uint8Array
) {
  let htmlInlinedData: string

  if (typeof chunk === 'string') {
    htmlInlinedData = htmlEscapeJsonString(
      JSON.stringify([INLINE_FLIGHT_PAYLOAD_DATA, chunk])
    )
  } else {
    // The chunk cannot be embedded as a UTF-8 string in the script tag.
    // Instead let's inline it in base64.
    // Credits to Devon Govett (devongovett) for the technique.
    // https://github.com/devongovett/rsc-html-stream
    const base64 =
      typeof Buffer !== 'undefined'
        ? Buffer.from(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength
          ).toString('base64')
        : btoa(String.fromCodePoint(...chunk))
    htmlInlinedData = htmlEscapeJsonString(
      JSON.stringify([INLINE_FLIGHT_PAYLOAD_BINARY, base64])
    )
  }

  controller.enqueue(
    encoder.encode(
      `${scriptStart}self.__next_f.push(${htmlInlinedData})</script>`
    )
  )
}
