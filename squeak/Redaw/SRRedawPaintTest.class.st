Class {
	#name : #SRRedawPaintTest,
	#superclass : #TestCase,
	#instVars : [
		'view',
		'window',
		'session'
	],
	#category : #'Redaw-Tests'
}

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> feature [
	^ view featureOf: SRRedawPaintFeature
]

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> items [
	^ (session at: 'state/squeak.paint/items') ifNil: [#()] ifNotNil: [:d | d values]
]

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> paint: canvasPoints [
	window isPainting ifFalse: [window togglePaint].
	window painter start: nil along: (self rayAt: canvasPoints first).
	canvasPoints allButFirst do: [:p | window painter addPointOn: (self rayAt: p)].
	^ window painter finish
]

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> rayAt: aCanvasPoint [
	"Straight down onto the canvas point, as seen through the map."
	| point |
	point := window portal globalTransform localPointToGlobal: aCanvasPoint x @ aCanvasPoint y @ 0.
	^ SRRay origin: point + (0 @ 1 @ 0) forward: 0 @ -1 @ 0
]

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> setUp [
	view := SRRedawSessionView new.
	view defaultFeatures do: [:each | each == SRRedawPaintFeature ifFalse: [view disable: each]].
	view session: (session := SRRedawTestSession new).
	view step: 0.
	window := SRRedawCanvasWindow for: view.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> testAStrokeFromAnotherPeerIsShown [
	session jsonAt: 'state/squeak.paint' put: '{"items":{},"order":[]}'.
	session at: 'state/squeak.paint/items/other' put: (JsonObject new at: 'id' put: 'other'; at: 'author' put: 'Leo'; at: 'color' put: '#ff0000'; at: 'width' put: 5; at: 'points' put: #(1 100 2 120); yourself).
	session at: 'state/squeak.paint/order/-' put: 'other'.
	view step: 0.
	self assert: self feature strokes size = 1.
	self assert: self feature batch triangleCount = 2.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> testAStrokeIsShownAtOnceAndOnceItComesBack [
	self paint: {window center. window center + (1 @ 0)}.
	self assert: self feature batch triangleCount > 0.
	self assert: self feature drawing triangleCount = 0.
	view step: 0.
	self assert: self feature strokes size = 1.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> testAStrokeIsWrittenUnderItsOwnId [
	| stroke stored |
	stroke := self paint: {window center. window center + (0.5 @ 0.2)}.
	self assert: self items size = 1.
	stored := self items first.
	self assert: (stored at: 'id') = (stroke at: 'id').
	self assert: (stored at: 'author') = 'Squeak'.
	self assert: (stored at: 'points') size = 4.
	self assert: (session at: 'state/squeak.paint/order') asArray = {stroke at: 'id'}.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> testPaintingDoesNotPan [
	| before |
	before := window center.
	self paint: {window center. window center + (1 @ 1)}.
	self assert: window center = before.
	self assert: (window instVarNamed: #drag) isNil.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> testThePointsComeBackWhereTheyWerePainted [
	| painted flat back |
	painted := {window center. window center + (0.7 @ -0.3). window center + (1.4 @ 0.1)}.
	self paint: painted.
	flat := self items first at: 'points'.
	back := (1 to: flat size - 1 by: 2) collect: [:i | self feature canvasPointAt: (flat at: i) y: (flat at: i + 1)].
	painted with: back do: [:a :b | self assert: (a - b) r < 1mm].
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> testTheStrokeIsAsWideOnThePlateAtEveryZoom [
	| first second |
	first := self paint: {window center. window center + (1 @ 0)}.
	window zoomBy: 2 at: nil.
	second := self paint: {window center. window center + (0.5 @ 0)}.
	self assert: ((first at: 'width') / (second at: 'width') - 2) abs < 0.05.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:01'
}
SRRedawPaintTest >> testTogglingPaintOffGoesBackToPanning [
	| point |
	window togglePaint.
	self deny: window togglePaint.
	self deny: window isPainting.
	point := window portal globalTransform localPointToGlobal: window center x @ window center y @ 0.
	window
		startDrag: (SRInputEventButton new button: #trigger; pressed: true; point: point; yourself)
		by: nil
		along: (self rayAt: window center).
	self assert: (window instVarNamed: #drag) notNil.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> testUndoRemovesOnlyStrokesPaintedHere [
	| mine |
	session jsonAt: 'state/squeak.paint' put: '{"items":{"other":{"id":"other","author":"Leo","points":[1,100,2,120]}},"order":["other"]}'.
	view step: 0.
	self paint: {window center. window center + (1 @ 0)}.
	mine := self paint: {window center. window center + (0 @ 1)}.
	self assert: self feature undo = (mine at: 'id').
	self assert: self feature undo notNil.
	self assert: self feature undo isNil.
	self assert: (self items collect: [:each | each at: 'id']) asArray = #('other').
	self assert: (session at: 'state/squeak.paint/order') asArray = #('other').
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawPaintTest >> testWhilePaintingTheDragDrawsAPreview [
	window togglePaint.
	window painter start: nil along: (self rayAt: window center).
	window painter addPointOn: (self rayAt: window center + (1 @ 0)).
	self assert: self feature drawing triangleCount = 2.
	self assert: self items isEmpty.
]
