"
Turns a trigger drag on a map into a stroke while the map is in paint mode. The hand is nil in tests.
"
Class {
	#name : #SRRedawMapPainter,
	#superclass : #Object,
	#instVars : [
		'window',
		'hand',
		'points'
	],
	#category : #'Redaw-Paint',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter class >> on: aWindow [
	^ self new setWindow: aWindow
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> addPointOn: aRay [
	| point |
	points ifNil: [^ self].
	point := (window canvasPointOn: aRay) ifNil: [^ self].
	(points notEmpty and: [(point - points last) r * window zoom < self spacing]) ifTrue: [^ self].
	points size >= self maxPoints ifTrue: [^ self].
	points add: point.
	self feature ifNotNil: [:f | f showDrawing: points width: self width color: self color].
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> cancel [
	points := nil.
	hand := nil.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> color [
	^ window color
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> feature [
	^ window canvas ifNotNil: [:c | c featureOf: SRRedawPaintFeature]
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> finish [
	| done |
	done := points.
	self cancel.
	(done isNil or: [done isEmpty]) ifTrue: [^ nil].
	^ self feature ifNotNil: [:f | f commit: done width: self width color: self color]
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> follow [
	"Every frame while drawing."
	(points isNil or: [hand isNil]) ifTrue: [^ self].
	hand trigger isPressed ifFalse: [^ self finish].
	self addPointOn: hand cursor redawRay.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> isDrawing [
	^ points notNil
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> maxPoints [
	^ 2000
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> setWindow: aWindow [
	window := aWindow.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> spacing [
	^ 3mm
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> start: aHand along: aRay [
	hand := aHand.
	points := OrderedCollection new.
	self addPointOn: aRay.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawMapPainter >> width [
	"The same on the plate at every zoom."
	^ 6mm / window zoom
]
