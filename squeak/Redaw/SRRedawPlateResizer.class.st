"
A corner handle of an SRRedawCanvasWindow's plate. SRResizer measures a Morph in its panel's XY plane; the plate lies in its window's XZ plane, with the top corners at the back.
"
Class {
	#name : #SRRedawPlateResizer,
	#superclass : #SRResizer,
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #constants,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawPlateResizer class >> minimumExtent [
	^ 30cm @ 20cm
]

{
	#category : #dragging,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawPlateResizer >> finishResize [
	self snapToCorner.
]

{
	#category : #geometry,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawPlateResizer >> handleOffset [
	"Outside the plate, so the handle never covers the canvas."
	| sign half |
	sign := self cornerSign.
	half := self class handleSize / 2.
	^ (sign x * half) @ 0 @ (sign y negated * half)
]

{
	#category : #geometry,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawPlateResizer >> localPositionForSign: aPoint [
	| size |
	size := panel size.
	^ (aPoint x * size x / 2) @ 0 @ (aPoint y negated * size y / 2)
]

{
	#category : #dragging,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawPlateResizer >> onGrabStarted: aHand [
	"Pinned once: recomputing per frame would make the anchor chase the plate."
	anchor := panel ifNotNil: [self anchorPosition].
	dragging := true.
]

{
	#category : #dragging,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawPlateResizer >> resizeToSpan: aVector3 [
	"aVector3 runs from the pinned corner to the hand, in the window's frame."
	panel ifNil: [^ self].
	panel keepCanvasWhile: [
		panel extent: (aVector3 x * self cornerSign x) @ (aVector3 z * self cornerSign y negated).
		self keepAnchorFixed].
	panel snapResizers.
]

{
	#category : #geometry,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawPlateResizer >> snapToCorner [
	panel ifNil: [^ self].
	self position: (self localPositionForSign: self cornerSign) + self handleOffset.
]
