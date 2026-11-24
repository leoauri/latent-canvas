"
The layer functions between the latent layer that plays the clips and the decoder, run offline over one clip as models.js streams it.
"
Class {
	#name : #RedawLatentChain,
	#superclass : #Object,
	#instVars : [
		'ports',
		'missing',
		'key',
		'sampleRate'
	],
	#category : #'Redaw-Audio',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain class >> forSession: aSession [
	^ self new setLayers: (self functionLayersOf: aSession)
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain class >> functionLayersOf: aSession [
	"The function layers in front of the latent layer that plays the clips, up to the decoder (the frontmost operator with a model)."
	| layers decoder latent |
	layers := aSession layers asArray.
	decoder := layers findLast: [:each | (each at: 'type' ifAbsent: [nil]) = 'operator' and: [each includesKey: 'model']].
	decoder = 0 ifTrue: [^ #()].
	latent := (1 to: decoder - 1) inject: 0 into: [:found :i |
		((layers at: i) at: 'type' ifAbsent: [nil]) = 'latent' ifTrue: [i] ifFalse: [found]].
	^ (layers copyFrom: latent + 1 to: decoder - 1) select: [:each |
		(each at: 'type' ifAbsent: [nil]) = 'operator' and: [(each includesKey: 'model') not and: [each includesKey: 'func']]]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain class >> keyFor: aSession [
	"Changes when a function or a parameter value does: renders made with another key are stale."
	^ String streamContents: [:s |
		(self functionLayersOf: aSession) do: [:each |
			s print: (each at: 'func') hash; space; print: (each at: 'paramValues' ifAbsent: [nil]); nextPut: $;]]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain >> key [
	^ key
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain >> missing [
	"Names of function layers without a port of their current source: they pass frames through."
	^ missing
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain >> render: latents dim: dim rate: framesPerSecond [
	"latents and the answer: little-endian float32, frame-major. The answer runs on past the clip by the functions' tails."
	| frames out bytes |
	ports isEmpty ifTrue: [^ latents].
	frames := (0 to: latents size // 4 // dim - 1) collect: [:i |
		(FloatArray new: dim) collectWithIndex: [:x :j | latents floatAt: i * dim + j - 1 * 4 + 1]].
	out := self run: frames rate: framesPerSecond.
	bytes := ByteArray new: out size * dim * 4.
	out doWithIndex: [:frame :i |
		frame doWithIndex: [:x :j | bytes floatAt: i - 1 * dim + j - 1 * 4 + 1 put: x]].
	^ bytes
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain >> run: frames rate: framesPerSecond [
	"As models.js streams a clip, one frame-grid step at a time, back to front: a function layer gets the frame from behind it, or, once its input stopped, a zero frame (its tail) until its output was quiet for 5 s, which also ends the voice's state. Steps where nothing reaches the decoder are filled with silence."
	| hop voices tails loudAts results step inputs silence |
	hop := sampleRate / framesPerSecond.
	voices := ports collect: [:each | each newVoice].
	tails := Array new: voices size.
	loudAts := Array new: voices size.
	results := OrderedCollection new.
	step := 0.
	[inputs := step < frames size
		ifTrue: [{RedawLatentFrame data: (frames at: step + 1) start: (step * hop) rounded rate: framesPerSecond}]
		ifFalse: [#()].
	 1 to: voices size do: [:i | | voice |
		voice := voices at: i.
		inputs isEmpty
			ifTrue: [(tails at: i) ifNotNil: [:previous | | zero out |
				zero := previous silenceAfter: hop.
				out := voice transform: zero sampleRate: sampleRate.
				(out notNil and: [out isAudible]) ifTrue: [loudAts at: i put: zero start].
				zero start - (loudAts at: i) > (5 * sampleRate)
					ifTrue: [tails at: i put: nil. voices at: i put: (ports at: i) newVoice]
					ifFalse: [tails at: i put: zero].
				inputs := out ifNil: [#()] ifNotNil: [{out}]]]
			ifFalse: [
				inputs := (inputs collect: [:frame |
					tails at: i put: frame.
					loudAts at: i put: frame start.
					voice transform: frame sampleRate: sampleRate]) reject: [:each | each isNil]]].
	 results addLast: (inputs isEmpty ifTrue: [nil] ifFalse: [inputs last data]).
	 step := step + 1.
	 step < frames size or: [(tails anySatisfy: [:each | each notNil]) and: [step < (120 * framesPerSecond)]]] whileTrue.
	[results notEmpty and: [results last isNil]] whileTrue: [results removeLast].
	silence := self silence ifNil: [FloatArray new: frames first size].
	^ results collect: [:each | each ifNil: [silence]]
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain >> setLayers: functionLayers [
	ports := OrderedCollection new.
	missing := OrderedCollection new.
	functionLayers do: [:each |
		(RedawLatentPort forLayer: each)
			ifNil: [missing add: (each at: 'name' ifAbsent: ['?'])]
			ifNotNil: [:port | ports add: port]].
	key := String streamContents: [:s |
		functionLayers do: [:each | s print: (each at: 'func') hash; space; print: (each at: 'paramValues' ifAbsent: [nil]); nextPut: $;]].
	sampleRate := 48000.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentChain >> silence [
	^ ports inject: nil into: [:found :each | found ifNil: [each class silence]]
]
