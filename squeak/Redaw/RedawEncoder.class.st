"
An encoder layer's model: audio in, latent frames out (channels wide, frameRate per second), as clips hold them.

	encoder := RedawEncoder forLayer: session encoderLayer peer: session peer.
	job := encoder submitSound: (SampledSound fromWaveFileNamed: 'voice.wav').
	latents := encoder latentsFor: job.	""nil while encoding; then a ByteArray, little-endian float32, frame-major""
	encoder close.

RedawSession>>addClipFromSound:t:y: does all of it and adds the clip to the session.
"
Class {
	#name : #RedawEncoder,
	#superclass : #RedawModel,
	#category : #'Redaw-Audio',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #testing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder class >> isEncoderConfig: aniraJsonString [
	"Whether an anira config describes an encoder: its streamed input is audio ([1, 1, hop]), not a latent frame ([1, channels, 1])."
	| shape |
	shape := [(((((Json readFrom: aniraJsonString readStream) at: 'inference_config') at: 'tensor_shape') first at: 'input_shape') first)]
		on: Error do: [:e | ^ false].
	^ shape last > 1
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> kind [
	^ 'encoder'
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> latentsFor: aJob [
	"nil while encoding; then the latents (little-endian float32, frame-major, channels per frame, frameRate frames per second), once."
	^ self resultOf: aJob into: [:buffer :capacity | library encoderLatents: handle job: aJob into: buffer capacity: capacity]
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> latentsOfSound: aSound [
	"Encode aSound and wait (yielding, not blocking the VM) for its latents."
	^ self waitFor: (self submitSound: aSound)
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> newBuffer: floats [
	^ ByteArray new: floats * 4
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> open: onnxBytes config: utf8Config [
	^ library encoderOpen: onnxBytes length: onnxBytes size config: utf8Config sampleRate: sampleRate threads: self class threads
]

{
	#category : #printing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> printOn: aStream [
	aStream nextPutAll: 'a RedawEncoder('.
	handle
		ifNil: [aStream nextPutAll: 'closed']
		ifNotNil: [aStream print: hop; nextPutAll: ' samples at '; print: sampleRate; nextPutAll: ' -> '; print: channels; nextPutAll: ' channels'].
	aStream nextPut: $)
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> resultOf: aJob [
	^ self latentsFor: aJob
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> submit: samples rate: samplesPerSecond [
	"samples: mono 16-bit audio, a SoundBuffer or a ByteArray of little-endian PCM; resampled to the model's rate. Answer the job."
	| count job |
	self checkOpen.
	count := (samples isKindOf: SoundBuffer) ifTrue: [samples monoSampleCount] ifFalse: [samples size // 2].
	job := library encoderSubmit: handle pcm16: samples count: count rate: samplesPerSecond asFloat.
	job < 0 ifTrue: [self error: 'redaw encoder: ', (library lastError ifNil: ['cannot submit'])].
	^ job
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawEncoder >> submitSound: aSound [
	"Encode any sound (stereo is mixed down). Answer the job."
	| sampled |
	sampled := (aSound isKindOf: SampledSound) ifTrue: [aSound] ifFalse: [aSound asSampledSound].
	^ self submit: sampled samples rate: sampled originalSamplingRate
]
