"
Many plain boxes drawn in one go and without writing depth, so translucent sheets do not hide each other or what lies behind them. Additive batches glow.
"
Class {
	#name : #SRRedawBoxBatch,
	#superclass : #SRObject,
	#instVars : [
		'boxes',
		'additive',
		'opaque'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawBoxBatch >> additive: aBoolean [
	additive := aBoolean.
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:26'
}
SRRedawBoxBatch >> at: aVector3 extent: anExtent color: aColor [
	"Structs are built once here: rendering only passes them on."
	| rl |
	rl := [:c | RlColor new
		r: (c red * 255) asInteger;
		g: (c green * 255) asInteger;
		b: (c blue * 255) asInteger;
		a: (c alpha * 255) asInteger;
		yourself].
	boxes add: {
		RlVector3 new x: aVector3 x asFloat; y: aVector3 y asFloat; z: aVector3 z asFloat; yourself.
		anExtent x asFloat. anExtent y asFloat. anExtent z asFloat.
		rl value: aColor.
		rl value: (aColor muchDarker alpha: aColor alpha)}.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawBoxBatch >> boxCount [
	^ boxes size
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawBoxBatch >> clear [
	boxes := OrderedCollection new.
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawBoxBatch >> initialize [
	super initialize.
	boxes := OrderedCollection new.
	additive := false.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:26'
}
SRRedawBoxBatch >> opaque: aBoolean [
	"Opaque batches write depth like any solid, and get dark outlines so neighbouring boxes stay apart."
	opaque := aBoolean.
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:26'
}
SRRedawBoxBatch >> renderOn: aRenderer [
	"The depth mask is part of the batch state: flush before switching it, or queued opaque geometry loses its depth."
	boxes isEmpty ifTrue: [^ self].
	opaque == true ifTrue: [
		^ aRenderer withTransform: self globalTransform do: [
			boxes do: [:b |
				Raylib drawCubePosition: (b at: 1) width: (b at: 2) height: (b at: 3) length: (b at: 4) color: (b at: 5).
				Raylib drawCubeWiresPosition: (b at: 1) width: (b at: 2) height: (b at: 3) length: (b at: 4) color: (b at: 6)]]].
	Raylib rlDrawRenderBatchActive; rlDisableDepthMask.
	Raylib beginBlendMode: (additive ifTrue: [1] ifFalse: [0]).
	[aRenderer withTransform: self globalTransform do: [
		boxes do: [:b | Raylib drawCubePosition: (b at: 1) width: (b at: 2) height: (b at: 3) length: (b at: 4) color: (b at: 5)]]]
		ensure: [
			Raylib endBlendMode; rlDrawRenderBatchActive; rlEnableDepthMask].
]
