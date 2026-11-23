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
		'duration'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound class >> job: anInteger [
	^ self new setJob: anInteger
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
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawClipSound >> pollWith: aRedawDecoder [
	"OpenAL may be off: the decoded audio waits until it is on."
	job ifNotNil: [
		(aRedawDecoder pcmFor: job) ifNotNil: [:bytes |
			pcm := bytes.
			duration := pcm size / 2 / aRedawDecoder sampleRate.
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
