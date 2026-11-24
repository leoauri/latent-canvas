"
Latents to audio with a decoder layer's streaming model (its ONNX file, anira config and meta, fetched from the room as blobs), decoded natively on worker threads: submit a clip's latents, then poll for its audio. A plain FFI call blocks the whole VM, which is why there is no synchronous decode.

	decoder := RedawDecoder forLayer: decoderLayer peer: session peer.	""nil while its files are fetched""
	job := decoder submit: (session peer blobAt: clip dataHash) rate: clip rate.
	decoder pcmFor: job.	""nil while decoding, then 16-bit mono PCM at decoder sampleRate""
	decoder close.
"
Class {
	#name : #RedawDecoder,
	#superclass : #RedawModel,
	#category : #'Redaw-Audio',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoder >> kind [
	^ 'decoder'
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoder >> newBuffer: samples [
	^ ByteArray new: samples * 2
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoder >> open: onnxBytes config: utf8Config [
	^ library decoderOpen: onnxBytes length: onnxBytes size config: utf8Config sampleRate: sampleRate threads: self class threads
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoder >> pcmFor: aJob [
	"nil while decoding; then the audio as 16-bit little-endian mono PCM, once."
	^ self resultOf: aJob into: [:buffer :capacity | library decoderPcm16: handle job: aJob into: buffer capacity: capacity]
]

{
	#category : #printing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> printOn: aStream [
	aStream nextPutAll: 'a RedawDecoder('.
	handle
		ifNil: [aStream nextPutAll: 'closed']
		ifNotNil: [aStream print: channels; nextPutAll: ' channels -> '; print: hop; nextPutAll: ' samples at '; print: sampleRate].
	aStream nextPut: $)
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoder >> resultOf: aJob [
	^ self pcmFor: aJob
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoder >> submit: latentBytes rate: framesPerSecond [
	"latentBytes: a clip's dataHash blob, little-endian float32, frame-major. Answer the job."
	| job |
	self checkOpen.
	job := library decoderSubmit: handle latents: latentBytes count: latentBytes size // 4 rate: framesPerSecond asFloat.
	job < 0 ifTrue: [self error: 'redaw decoder: ', (library lastError ifNil: ['cannot submit'])].
	^ job
]
