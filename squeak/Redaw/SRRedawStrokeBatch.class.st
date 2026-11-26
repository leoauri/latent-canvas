"
Strokes as flat ribbons of triangles in my XY plane. The structs are built once, rendering only passes them on.
"
Class {
	#name : #SRRedawStrokeBatch,
	#superclass : #SRObject,
	#instVars : [
		'triangles'
	],
	#category : #'Redaw-Paint',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawStrokeBatch >> addDot: aPoint half: aNumber color: anRlColor [
	| a b c d |
	a := self vertex: aPoint + (aNumber negated @ aNumber negated).
	b := self vertex: aPoint + (aNumber @ aNumber negated).
	c := self vertex: aPoint + (aNumber @ aNumber).
	d := self vertex: aPoint + (aNumber negated @ aNumber).
	triangles add: {a. b. c. anRlColor}; add: {a. c. d. anRlColor}.
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawStrokeBatch >> addStroke: somePoints width: aNumber color: aColor [
	"Each point's side offset is taken across both its neighbours, so turns do not open gaps."
	| half rl left right |
	somePoints isEmpty ifTrue: [^ self].
	half := aNumber / 2.
	rl := RlColor new
		r: (aColor red * 255) asInteger;
		g: (aColor green * 255) asInteger;
		b: (aColor blue * 255) asInteger;
		a: (aColor alpha * 255) asInteger;
		yourself.
	somePoints size = 1 ifTrue: [^ self addDot: somePoints first half: half color: rl].
	left := OrderedCollection new.
	right := OrderedCollection new.
	somePoints doWithIndex: [:p :i | | dir side |
		dir := (somePoints at: (i + 1 min: somePoints size)) - (somePoints at: (i - 1 max: 1)).
		side := dir r < 1.0e-12
			ifTrue: [0 @ half]
			ifFalse: [(dir y negated @ dir x) * (half / dir r)].
		left add: (self vertex: p + side).
		right add: (self vertex: p - side)].
	1 to: somePoints size - 1 do: [:i |
		triangles add: {left at: i. right at: i. right at: i + 1. rl}.
		triangles add: {left at: i. right at: i + 1. left at: i + 1. rl}].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawStrokeBatch >> clear [
	triangles := OrderedCollection new.
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawStrokeBatch >> initialize [
	super initialize.
	triangles := OrderedCollection new.
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawStrokeBatch >> renderOn: aRenderer [
	triangles isEmpty ifTrue: [^ self].
	aRenderer withTransform: self globalTransform do: [
		aRenderer withoutBackfaceCullingDo: [
			triangles do: [:t | Raylib drawTriangle3DV1: (t at: 1) v2: (t at: 2) v3: (t at: 3) color: (t at: 4)]]].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawStrokeBatch >> triangleCount [
	^ triangles size
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawStrokeBatch >> vertex: aPoint [
	^ RlVector3 new x: aPoint x asFloat; y: aPoint y asFloat; z: 0.0; yourself
]
