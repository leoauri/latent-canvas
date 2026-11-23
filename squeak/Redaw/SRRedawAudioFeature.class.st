"
Plays the clips under the SRRedawPlayheadFeature's cursor, decoded by the session's decoder layer (the frontmost operator with a model). Every clip is decoded once, as a whole, as the page's pre-bake does, and started when the playhead reaches it.

Not yet as the page does: the layer functions (boost, echo, fades ...) and the masks are not applied, only the decoder.
"
Class {
	#name : #SRRedawAudioFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'decoder',
		'sounds',
		'voices',
		'lastTime',
		'wasPlaying',
		'label',
		'status'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> clear [
	super clear.
	label := nil
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> deactivate [
	self stopAll.
	sounds do: [:each | each free].
	sounds removeAll.
	decoder ifNotNil: [decoder close. decoder := nil]
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> decodeClips [
	| clips ready |
	clips := self session clips asArray.
	clips do: [:clip |
		clip dataHash ifNotNil: [:hash |
			(sounds at: (self keyFor: clip) ifAbsent: [nil])
				ifNil: [(self session peer blobAt: hash) ifNotNil: [:bytes |
					sounds at: (self keyFor: clip) put: (SRRedawClipSound job: (decoder submit: bytes rate: clip rate))]]
				ifNotNil: [:sound | sound isReady ifFalse: [sound pollWith: decoder]]]].
	ready := clips count: [:clip | (sounds at: (self keyFor: clip) ifAbsent: [nil]) ifNil: [false] ifNotNil: [:sound | sound isReady]].
	status := 'audio: ', ready printString, '/', clips size printString, ' clips decoded',
		(SRAudioObject audioEnabled ifTrue: [''] ifFalse: [' (SqueakXR audio is off)']),
		(voices isEmpty ifTrue: [''] ifFalse: [', ', voices size printString, ' playing'])
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> decoder [
	^ decoder
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> decoderLayer [
	"The frontmost operator with a model: what reaches the audio output, in the page's stack."
	^ self session layers reverse
		detect: [:each | (each at: 'type' ifAbsent: [nil]) = 'operator' and: [(each at: 'model' ifAbsent: [nil]) notNil]]
		ifNone: [nil]
]

{
	#category : #playback,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> delete: aSource [
	OpenAL alSourceStopSource: aSource first.
	OpenAL alDeleteSourcesN: 1 sources: aSource
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> ensureDecoder [
	| layer |
	(decoder notNil and: [decoder isOpen]) ifTrue: [^ true].
	layer := self decoderLayer ifNil: [status := 'audio: no decoder layer'. ^ false].
	decoder := RedawDecoder forLayer: layer peer: self session peer.
	decoder ifNil: [status := 'audio: fetching ', (layer at: 'name' ifAbsent: ['the decoder']), ' from the room'. ^ false].
	^ true
]

{
	#category : #playback,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> followPlayhead [
	"Start each clip as the playhead reaches it; after a jump, every clip under it from where it is."
	| playhead now jumped |
	playhead := view featureOf: SRRedawPlayheadFeature.
	(playhead isNil or: [playhead isPlaying not]) ifTrue: [
		self stopAll.
		wasPlaying := false.
		^ self].
	now := playhead time.
	jumped := wasPlaying not or: [now < lastTime or: [now - lastTime > 0.5]].
	jumped ifTrue: [self stopAll].
	self reapFinished.
	self session clips do: [:clip | | sound |
		sound := sounds at: (self keyFor: clip) ifAbsent: [nil].
		(sound notNil and: [sound isReady
			and: [(voices includesKey: clip id) not
			and: [clip t <= now
			and: [now < (clip t + sound duration)
			and: [jumped or: [clip t > lastTime]]]]]])
				ifTrue: [self start: clip sound: sound at: now - clip t]].
	wasPlaying := true.
	lastTime := now
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> initialize [
	super initialize.
	sounds := Dictionary new.
	voices := Dictionary new.
	wasPlaying := false.
	lastTime := 0.
	status := 'audio: starting'
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> invalidate [
	label := nil
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> keyFor: aRedawClip [
	"Clips that share latents and rate share their audio."
	^ aRedawClip dataHash -> aRedawClip rate
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> layout [
	label := SRTextField new
		text: (self plain: status);
		color: (Color gray: 0.85);
		scale: 4cm asVector3;
		rotation: SRTextField uprightRotation;
		position: 45cm @ (view canvasExtent y / -2 - 6cm) @ 1cm;
		yourself.
	self addChild: label
]

{
	#category : #playback,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> reapFinished [
	| state finished |
	voices isEmpty ifTrue: [^ self].
	SRAudioObject ensureOpenAL ifFalse: [^ voices removeAll].
	state := ExternalType int32_t allocate.
	finished := voices keys select: [:id |
		OpenAL alGetSourceiSource: (voices at: id) first param: AlDefines alSourceState value: state.
		state first ~= AlDefines alPlaying].
	finished do: [:id | self delete: (voices removeKey: id)]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> refresh [
	"Every frame: decoding and playback move on without a relayout."
	label ifNil: [^ true].
	[self ensureDecoder ifTrue: [
		self decodeClips.
		self followPlayhead]]
			on: Error do: [:e | lastError := e. status := 'audio: ', e messageText].
	label text: (self plain: status).
	^ false
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawAudioFeature >> sounds [
	^ sounds
]

{
	#category : #playback,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> start: aRedawClip sound: aClipSound at: seconds [
	"Not spatial: the canvas is tens of metres wide, its clips would be out of earshot."
	| source |
	SRAudioObject ensureOpenAL ifFalse: [^ self].
	source := ExternalType uint32_t allocate.
	OpenAL alGenSourcesN: 1 sources: source.
	OpenAL alSourceiSource: source first param: AlDefines alSourceRelative value: 1.
	OpenAL alSource3fSource: source first param: AlDefines alPosition value1: 0.0 value2: 0.0 value3: 0.0.
	OpenAL alSourceiSource: source first param: AlDefines alBuffer value: aClipSound buffer first.
	OpenAL alSourcefSource: source first param: AlDefines alSecOffset value: seconds asFloat.
	OpenAL alSourcePlaySource: source first.
	voices at: aRedawClip id put: source
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> status [
	^ status
]

{
	#category : #playback,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> stopAll [
	voices isEmpty ifTrue: [^ self].
	SRAudioObject ensureOpenAL ifTrue: [voices do: [:source | self delete: source]].
	voices removeAll
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> update [
	^ false
]
