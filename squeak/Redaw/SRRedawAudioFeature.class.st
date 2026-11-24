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
		'status',
		'renders',
		'current',
		'retired',
		'results',
		'renderer',
		'rendering',
		'chainKey',
		'chainMissing'
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
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:04'
}
SRRedawAudioFeature >> deactivate [
	rendering := false.
	self stopAll.
	sounds do: [:each | each free].
	sounds removeAll.
	renders do: [:each | each free].
	renders removeAll.
	retired do: [:each | each free].
	retired removeAll.
	current removeAll.
	decoder ifNotNil: [decoder close. decoder := nil].
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:04'
}
SRRedawAudioFeature >> decodeClips [
	"Renders arrive from the render process; each becomes the clip's sound once decoded, replacing an older render only then."
	| clips ready |
	self ensureRenderer.
	[results isEmpty] whileFalse: [| result |
		result := results next.
		renders at: result first put: (SRRedawClipSound job: (decoder submit: result second rate: result third))].
	renders copy keysAndValuesDo: [:key :sound |
		sound isReady ifFalse: [sound pollWith: decoder].
		sound isReady ifTrue: [
			renders removeKey: key.
			(key value = chainKey or: [(sounds includesKey: key key) not])
				ifTrue: [
					(sounds at: key key ifAbsent: [nil]) ifNotNil: [:old | retired add: old].
					sounds at: key key put: sound.
					current at: key key put: key value]
				ifFalse: [sound free]]].
	clips := self session clips asArray.
	ready := clips count: [:clip | (current at: (self keyFor: clip) ifAbsent: [nil]) = chainKey].
	status := 'audio: ', ready printString, '/', clips size printString, ' clips rendered',
		((chainMissing isNil or: [chainMissing isEmpty]) ifTrue: [''] ifFalse: [', no Smalltalk port of ', (chainMissing inject: '' into: [:all :each | all, ' ', each]), ' (passed through)']),
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
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:04'
}
SRRedawAudioFeature >> ensureRenderer [
	(renderer notNil and: [renderer isTerminated not]) ifTrue: [^ self].
	rendering := true.
	renderer := [self renderLoop] forkAt: Processor userBackgroundPriority named: 'Redaw clip renderer'.
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
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:04'
}
SRRedawAudioFeature >> initialize [
	super initialize.
	sounds := Dictionary new.
	renders := Dictionary new.
	current := Dictionary new.
	retired := OrderedCollection new.
	results := SharedQueue new.
	voices := Dictionary new.
	wasPlaying := false.
	lastTime := 0.
	status := 'audio: starting'.
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
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:04'
}
SRRedawAudioFeature >> nextRenderFor: aChainKey notIn: done [
	"The clip nearest the playhead that is not rendered with this chain yet, with its latents; latents not here yet are fetched."
	| now best bestDistance |
	now := (view featureOf: SRRedawPlayheadFeature) ifNil: [0] ifNotNil: [:playhead | playhead time].
	self session clips asArray do: [:clip |
		(clip dataHash notNil and: [(done includes: (self keyFor: clip) -> aChainKey) not]) ifTrue: [| distance |
			distance := clip t > now ifTrue: [clip t - now] ifFalse: [0 max: now - (clip t + clip duration)].
			(best isNil or: [distance < bestDistance]) ifTrue: [
				(self session peer blobAt: clip dataHash)
					ifNil: [self session peer fetchBlob: clip dataHash]
					ifNotNil: [:bytes | best := clip -> bytes. bestDistance := distance]]]].
	^ best
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
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:04'
}
SRRedawAudioFeature >> renderLoop [
	"A clip takes up to a second to render through the layer functions: too long for a frame."
	| done chain |
	done := Set new.
	[rendering == true and: [parent notNil]] whileTrue: [
		[| key work |
		 key := RedawLatentChain keyFor: self session.
		 (chain isNil or: [chain key ~= key]) ifTrue: [
			chain := RedawLatentChain forSession: self session.
			chainMissing := chain missing.
			chainKey := chain key].
		 work := self nextRenderFor: chain key notIn: done.
		 work
			ifNil: [(Delay forMilliseconds: 200) wait]
			ifNotNil: [
				results nextPut: {(self keyFor: work key) -> chain key. chain render: work value dim: work key dim rate: work key rate. work key rate}.
				done add: (self keyFor: work key) -> chain key.
				Processor yield]]
			on: Error do: [:e | lastError := e. (Delay forSeconds: 1) wait]].
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
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:04'
}
SRRedawAudioFeature >> stopAll [
	voices isEmpty ifFalse: [
		SRAudioObject ensureOpenAL ifTrue: [voices do: [:source | self delete: source]].
		voices removeAll].
	retired do: [:each | each free].
	retired removeAll.
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawAudioFeature >> update [
	^ false
]
