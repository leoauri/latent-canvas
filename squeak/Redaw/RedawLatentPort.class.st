"
A Smalltalk port of a layer function (JS, the layer's func). The JS is the meaning; a port answers the exact source it was ported from (class side #jsSource) and is used only for layers whose func is that source. When a function changes in the browser, its layer passes frames through unchanged (as the page does when a function throws) until someone, e.g. an AI, ports the new source. Instances hold the state of one voice.
"
Class {
	#name : #RedawLatentPort,
	#superclass : #Object,
	#instVars : [
		'params'
	],
	#classInstVars : [
		'constants'
	],
	#category : #'Redaw-Audio',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #constants,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort class >> constant: aName [
	"A numeric constant of the JS source (const S = [...];), as FloatArrays: the port and its source are the same text."
	| source from to json |
	source := self jsSource.
	constants ifNil: [constants := Dictionary new].
	^ constants at: aName -> source hash ifAbsentPut: [
		from := (source indexOfSubCollection: 'const ', aName, ' = ') + aName size + 9.
		to := source indexOf: $; startingAt: from.
		json := Json readFrom: (source copyFrom: from to: to - 1) readStream.
		json first isNumber
			ifTrue: [FloatArray withAll: json]
			ifFalse: [(json collect: [:each | FloatArray withAll: each]) asArray]]
]

{
	#category : #porting,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort class >> defaults [
	^ Dictionary new
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort class >> forLayer: aLayer [
	"A port of the layer's function with its parameter values, or nil if no class ports this source."
	| source port |
	source := (aLayer at: 'func' ifAbsent: [^ nil]) withSqueakLineEndings.
	port := self allSubclasses
		detect: [:each | each jsSource notNil and: [each jsSource withSqueakLineEndings = source]]
		ifNone: [^ nil].
	^ port new setParams: (aLayer at: 'paramValues' ifAbsent: [nil])
]

{
	#category : #porting,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort class >> jsSource [
	"The layer function this class is a port of, exactly as on the layer."
	^ nil
]

{
	#category : #constants,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort class >> silence [
	"The encoder's silence latent, for ports that know it."
	^ nil
]

{
	#category : #transforming,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort >> mix: base weight: w with: aFloatArray [
	^ base + ((aFloatArray - base) * w)
]

{
	#category : #copying,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort >> newVoice [
	^ self copy resetVoice; yourself
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort >> param: aName [
	^ params at: aName
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort >> resetVoice [
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort >> setParams: aJsonObject [
	params := self class defaults copy.
	aJsonObject ifNotNil: [aJsonObject keysAndValuesDo: [:name :value | params at: name put: value]].
	self resetVoice.
]

{
	#category : #transforming,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentPort >> transform: aFrame sampleRate: samplesPerSecond [
	"Answer the frame to send on, or nil to send nothing."
	^ self subclassResponsibility
]
