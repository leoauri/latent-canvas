"
One clip decoded by a RedawDecoder, in an OpenAL buffer once it is done.
"
Class {
	#name : #SRRedawClipSound,
	#superclass : #Object,
	#instVars : [
		'job',
		'pcm',
		'buffer',
		'duration',
		'envelope'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #envelope,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawClipSound class >> envelopeOf: aByteArray sampleRate: aRate [
	"Peak per bin, 0 to 1. Every fourth sample is enough for a picture."
	| perBin n env |
	perBin := (aRate * self envelopeSeconds) rounded.
	n := aByteArray size // 2.
	env := FloatArray new: n + perBin - 1 // perBin.
	1 to: env size do: [:bin | | peak |
		peak := 0.
		(bin - 1 * perBin + 1) to: (bin * perBin min: n) by: 4 do: [:i |
			peak := peak max: (aByteArray shortAt: i * 2 - 1 bigEndian: false) abs].
		env at: bin put: peak / 32768.0].
	^ env
]

{
	#category : #envelope,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawClipSound class >> envelopeSeconds [
	^ 0.1
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound class >> job: anInteger [
	^ self new setJob: anInteger
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawClipSound >> amplitudeAt: seconds [
	| i |
	(envelope isNil or: [seconds < 0]) ifTrue: [^ 0].
	i := (seconds / self class envelopeSeconds) floor + 1.
	^ i > envelope size ifTrue: [0] ifFalse: [envelope at: i]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound >> buffer [
	^ buffer
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound >> duration [
	^ duration
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawClipSound >> envelope [
	^ envelope
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound >> free [
	(buffer notNil and: [SRAudioObject ensureOpenAL]) ifTrue: [OpenAL alDeleteBuffersN: 1 buffers: buffer].
	buffer := nil
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound >> isDecoded [
	^ pcm notNil or: [buffer notNil]
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound >> isReady [
	^ buffer notNil
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawClipSound >> pollWith: aRedawDecoder [
	"OpenAL may be off: the decoded audio waits until it is on."
	job ifNotNil: [
		(aRedawDecoder pcmFor: job) ifNotNil: [:bytes |
			pcm := bytes.
			duration := pcm size / 2 / aRedawDecoder sampleRate.
			envelope := self class envelopeOf: pcm sampleRate: aRedawDecoder sampleRate.
			job := nil]].
	(pcm notNil and: [SRAudioObject ensureOpenAL]) ifTrue: [
		buffer := ExternalType uint32_t allocate.
		OpenAL alGenBuffersN: 1 buffers: buffer.
		OpenAL alBufferDataBuffer: buffer first format: AlDefines alFormatMono16 data: pcm size: pcm size samplerate: aRedawDecoder sampleRate.
		pcm := nil]
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound >> setJob: anInteger [
	job := anInteger
]
