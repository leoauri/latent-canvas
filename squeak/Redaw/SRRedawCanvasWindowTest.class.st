Class {
	#name : #SRRedawCanvasWindowTest,
	#superclass : #TestCase,
	#instVars : [
		'view',
		'window'
	],
	#category : #'Redaw-Tests'
}

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasWindowTest >> cutOf: rows at: aPoint [
	"The larger of the two plate coordinates, as the shader computes them: inside up to 0.5."
	| row |
	row := [:offset | ((rows floatAt: offset) * aPoint x) + ((rows floatAt: offset + 4) * aPoint y) + ((rows floatAt: offset + 8) * aPoint z) + (rows floatAt: offset + 12)].
	^ (row value: 1) abs max: (row value: 33) abs
]

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindowTest >> drag: aResizer by: aVector3 [
	"As SRGrabAction does: the handle follows the hand."
	aResizer onGrabStarted: nil.
	aResizer dragTo: (Matrix4x4 withOffset: aResizer globalTranslation + aVector3).
	aResizer onGrabStopped: nil.
]

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindowTest >> resizerAt: aCorner [
	^ window children detect: [:each | (each isKindOf: SRRedawPlateResizer) and: [each corner == aCorner]]
]

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasWindowTest >> setUp [
	view := SRRedawSessionView new.
	window := SRRedawCanvasWindow for: view.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindowTest >> testDraggingACornerResizesThePlateAndPinsTheOpposite [
	| resizer pinned |
	resizer := self resizerAt: #bottomRight.
	pinned := window globalTransform localPointToGlobal: (window size x / -2) @ 0 @ (window size y / -2).
	self drag: resizer by: 20cm @ 0 @ 10cm.
	self assert: ((window size x - 100cm) abs < 1.0e-4).
	self assert: ((window size y - 60cm) abs < 1.0e-4).
	self assert: ((window globalTransform localPointToGlobal: (window size x / -2) @ 0 @ (window size y / -2)) - pinned) length < 1.0e-4.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:06'
}
SRRedawCanvasWindowTest >> testDraggingKeepsTheGrabbedPointUnderTheRay [
	| down from to anchor |
	down := 0 @ -1 @ 0.
	from := SRRay origin: 10cm @ 1 @ 5cm forward: down.
	to := SRRay origin: -15cm @ 1 @ -5cm forward: down.
	anchor := window canvasPointOn: from.
	window keep: anchor under: to.
	self assert: ((window canvasPointOn: to) - anchor) r < 1.0e-4.
	self assert: window center x > 0.
	self assert: window center y < 0.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindowTest >> testTheCanvasStaysWhileThePlateResizes [
	| before |
	before := window portal globalTranslation.
	self drag: (self resizerAt: #topLeft) by: -30cm @ 0 @ -20cm.
	self assert: (window portal globalTranslation - before) length < 1.0e-4.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasWindowTest >> testTheCentreShowsAtTheMiddleAndThePageTopRunsAway [
	| middle back |
	window panBy: 0.5 @ 0.
	middle := window portal globalTransform globalPointToLocal: (window globalTransform localPointToGlobal: 0 @ window canvasHeight @ 0).
	back := window portal globalTransform globalPointToLocal: (window globalTransform localPointToGlobal: 0 @ window canvasHeight @ -10cm).
	self assert: (middle x - window center x) abs < 1.0e-3.
	self assert: middle y abs < 1.0e-3.
	self assert: (back y - (10cm / window zoom)) abs < 1.0e-2.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:56'
}
SRRedawCanvasWindowTest >> testTheMarkerShowsTheRegionInCanvasSpace [
	| marker box before |
	window attachMarker.
	marker := view canvasSpace children detect: [:each | each name = 'Map 1 region'].
	box := marker children first.
	self assert: (box isKindOf: SRRedawMapMarker).
	self assert: (box scale x - (window size x / window zoom)) abs < 1.0e-4.
	window panBy: 0.013 @ 0.007.
	self assert: (box translation x - window center x) abs < 1.0e-4.
	self assert: (box translation y - window center y) abs < 1.0e-4.
	before := window canvasRect.
	window extent: window size * 2.
	self assert: (box scale x - (before width * 2)) abs < 1.0e-4.
	window detachMarker.
	self deny: (view canvasSpace children anySatisfy: [:each | each name = 'Map 1 region']).
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasWindowTest >> testThePlateCutsOnlyItsOutline [
	| rows |
	rows := window clipRowsFor: Matrix4x4 identity.
	self assert: (self cutOf: rows at: 39cm @ 0 @ 24cm) <= 0.5.
	self assert: (self cutOf: rows at: 0 @ 3 @ 0) <= 0.5.
	self assert: (self cutOf: rows at: 41cm @ 0 @ 0) > 0.5.
	self assert: (self cutOf: rows at: 0 @ 0 @ -26cm) > 0.5.
	self assert: ((17 to: 32) allSatisfy: [:i | (rows at: i) = 0]).
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindowTest >> testThePlateKeepsAMinimumAndItsButtonsWrap [
	| play |
	self drag: (self resizerAt: #bottomRight) by: -2 @ 0 @ -2.
	self assert: window size = SRRedawPlateResizer minimumExtent.
	play := window children detect: [:each | (each isKindOf: SRActionSign) and: [each label = 'Play']].
	self assert: (window children select: [:each | (each isKindOf: SRActionSign) and: [each translation z > play translation z]]) notEmpty.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasWindowTest >> testThePlateMovesWithTheWindow [
	| rows |
	window translation: 1 @ 0 @ 2; rotation: (Quaternion angle: 90 axis: Vector3 up).
	rows := window clipRowsFor: Matrix4x4 identity.
	self assert: (window coversWorldPoint: 1 @ 0 @ (2 + 35cm)).
	self deny: (window coversWorldPoint: (1 + 35cm) @ 0 @ 2).
	self assert: (self cutOf: rows at: 1 @ 0 @ (2 + 35cm)) <= 0.5.
	self assert: (self cutOf: rows at: (1 + 35cm) @ 0 @ 2) > 0.5.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:02'
}
SRRedawCanvasWindowTest >> testTheScaleKeepsADecimalBelowOneToTen [
	window instVarNamed: 'zoom' put: 1 / 1.4.
	self assert: window scaleText = '1:1.4'.
	window instVarNamed: 'zoom' put: 1 / 28.3.
	self assert: window scaleText = '1:28'.
	window instVarNamed: 'zoom' put: 1.5.
	self assert: window scaleText = '1.5:1'.
]
