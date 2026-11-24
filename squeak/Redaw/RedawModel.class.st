"
An operator layer's streaming model (its ONNX file and anira config, shared in the session as blobs) running in redaw_peer.dll on worker threads. Submit a job, then poll for its result: no call blocks the VM for long. RedawDecoder turns a clip's latents into audio, RedawEncoder audio into latents.
"
Class {
	#name : #RedawModel,
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
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel class >> forLayer: aLayer peer: aRedawPeer [
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
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel class >> in: hashes endingWith: aSuffix [
	^ hashes at: (hashes keys detect: [:each | each endsWith: aSuffix] ifNone: [^ self error: 'the model has no *', aSuffix])
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel class >> threads [
	^ 4
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> channels [
	^ channels
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> checkOpen [
	handle ifNil: [self error: 'redaw ', self kind, ' is closed']
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> close [
	handle ifNil: [^ self].
	library decoderClose: handle.
	handle := nil
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> frameRate [
	"Latent frames per second."
	^ sampleRate / hop
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> hop [
	^ hop
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> isOpen [
	^ handle notNil
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> kind [
	^ self subclassResponsibility
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> newBuffer: size [
	^ self subclassResponsibility
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> open: onnxBytes config: configString [
	"Load the model in the library; answer its handle."
	^ self subclassResponsibility
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> resultOf: aJob [
	^ self subclassResponsibility
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> resultOf: aJob into: aBlock [
	"nil while the job runs; then its result, once: aBlock value: buffer value: capacity fills a buffer from the library (answering the result's size) and is sent once with nil to learn it."
	| size buffer |
	self checkOpen.
	size := aBlock value: nil value: 0.
	size = -1 ifTrue: [^ nil].
	size < 0 ifTrue: [^ self error: 'redaw ', self kind, ': ', (library lastError ifNil: ['the job failed'])].
	buffer := self newBuffer: size.
	(aBlock value: buffer value: size) = size
		ifFalse: [^ self error: 'redaw ', self kind, ': ', (library lastError ifNil: ['lost the result'])].
	^ buffer
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> sampleRate [
	^ sampleRate
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> setOnnx: onnxBytes config: configString meta: metaJson [
	library := RedawDecoderLibrary default.
	sampleRate := metaJson at: 'sample_rate'.
	handle := self open: onnxBytes config: configString squeakToUtf8.
	(handle isNil or: [handle isNull]) ifTrue: [
		handle := nil.
		^ self error: 'redaw ', self kind, ': ', (library lastError ifNil: ['cannot open'])].
	hop := library decoderHop: handle.
	channels := library decoderChannels: handle
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawModel >> waitFor: aJob [
	"Poll (yielding to other processes) until the job is done; answer its result."
	[(self resultOf: aJob) ifNotNil: [:result | ^ result].
	 (Delay forMilliseconds: 20) wait] repeat
]
