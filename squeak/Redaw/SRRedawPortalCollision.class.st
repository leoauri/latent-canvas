"
A portal's collision: the ray is cast among the objects in canvas space, whose own geometry the cursor never sees.
"
Class {
	#name : #SRRedawPortalCollision,
	#superclass : #SRCollisionGeometry,
	#instVars : [
		'portal'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #drawing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawPortalCollision >> drawGizmoOn: aGizmoPainter colored: aColor [
	"A highlight of the whole canvas would cover the floor."
]

{
	#category : #intersection,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawPortalCollision >> intersectsBoxCenter: aCentre halfExtents: aHalfExtents [
	^ portal intersectsBoxCenter: aCentre halfExtents: aHalfExtents
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawPortalCollision >> portal: aCanvasPortal [
	portal := aCanvasPortal.
]

{
	#category : #intersection,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawPortalCollision >> rayIntersection: aRay [
	^ portal worldHitFor: aRay
]
