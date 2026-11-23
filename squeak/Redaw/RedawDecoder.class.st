"
Latents to audio with a decoder layer's streaming model (its ONNX file, anira config and meta, fetched from the room as blobs), decoded natively on worker threads: submit a clip's latents, then poll for its audio. A plain FFI call blocks the whole VM, which is why there is no synchronous decode.

	decoder := RedawDecoder forLayer: decoderLayer peer: session peer.	""nil while its files are fetched""
	job := decoder submit: (session peer blobAt: clip dataHash) rate: clip rate.
	decoder pcmFor: job.	""nil while decoding, then 16-bit mono PCM at decoder sampleRate""
	decoder close.
"
Class {
	#name : #RedawDecoder,
	#superclass : #Object,
	#instVars : [
		'library',
		'handle',
		'sampleRate',
		'hop',
		'channels'
	],
	#category : #'Redaw-Audio',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder class >> forLayer: aLayer peer: aRedawPeer [
	"Answer nil while the model's files are still on their way from the room."
	| hashes files |
	hashes := (aLayer at: 'model') at: 'hashes'.
	hashes do: [:each | aRedawPeer fetchBlob: each].
	files := Dictionary new.
	hashes keysAndValuesDo: [:name :hash |
		files at: name put: ((aRedawPeer blobStatus: hash) at: 'state' ifAbsent: [nil]) = 'done'].
	(files includes: false) ifTrue: [^ nil].
	^ self new
		setOnnx: (aRedawPeer blobAt: (self in: hashes endingWith: '.onnx'))
		config: (aRedawPeer blobAt: (self in: hashes endingWith: '.anira.json')) asString
		meta: (Json readFrom: (aRedawPeer blobAt: (self in: hashes endingWith: '.meta.json')) asString readStream)
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder class >> in: hashes endingWith: aSuffix [
	^ hashes at: (hashes keys detect: [:each | each endsWith: aSuffix] ifNone: [^ self error: 'the model has no *', aSuffix])
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder class >> threads [
	^ 4
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> channels [
	^ channels
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> checkOpen [
	handle ifNil: [self error: 'redaw decoder is closed']
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> close [
	handle ifNil: [^ self].
	library decoderClose: handle.
	handle := nil
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> hop [
	^ hop
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> isOpen [
	^ handle notNil
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> pcmFor: aJob [
	"nil while decoding; then the audio as 16-bit little-endian mono PCM, once."
	| samples pcm |
	self checkOpen.
	samples := library decoderPcm16: handle job: aJob into: nil capacity: 0.
	samples = -1 ifTrue: [^ nil].
	samples < 0 ifTrue: [^ self error: 'redaw decoder: ', (library lastError ifNil: ['decoding failed'])].
	pcm := ByteArray new: samples * 2.
	(library decoderPcm16: handle job: aJob into: pcm capacity: samples) = samples
		ifFalse: [^ self error: 'redaw decoder: ', (library lastError ifNil: ['lost the audio'])].
	^ pcm
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
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> sampleRate [
	^ sampleRate
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> setOnnx: onnxBytes config: configString meta: metaJson [
	library := RedawDecoderLibrary default.
	sampleRate := metaJson at: 'sample_rate'.
	handle := library
		decoderOpen: onnxBytes
		length: onnxBytes size
		config: configString squeakToUtf8
		sampleRate: sampleRate
		threads: self class threads.
	(handle isNil or: [handle isNull]) ifTrue: [
		handle := nil.
		^ self error: 'redaw decoder: ', (library lastError ifNil: ['cannot open'])].
	hop := library decoderHop: handle.
	channels := library decoderChannels: handle
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoder >> submit: latentBytes rate: framesPerSecond [
	"latentBytes: a clip's dataHash blob, little-endian float32, frame-major. Answer the job."
	| job |
	self checkOpen.
	job := library decoderSubmit: handle latents: latentBytes count: latentBytes size // 4 rate: framesPerSecond asFloat.
	job < 0 ifTrue: [self error: 'redaw decoder: ', (library lastError ifNil: ['cannot submit'])].
	^ job
]
