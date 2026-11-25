Class {
	#name : #SRRedawCanvasPortalTest,
	#superclass : #TestCase,
	#instVars : [
		'view',
		'received'
	],
	#category : #'Redaw-Tests'
}

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasPortalTest >> floorPortal [
	^ view children detect: [:each | each isKindOf: SRRedawCanvasPortal]
]

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasPortalTest >> setUp [
	view := SRRedawSessionView new.
	received := OrderedCollection new.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasPortalTest >> testARayIsCastInCanvasSpaceAndMappedBack [
	| hit |
	view canvasSpace addChild: (SRCube new translation: 1 @ 2 @ 0; yourself).
	view translation: 0 @ 0 @ -5; scale: 2 asVector3.
	hit := self floorPortal worldHitFor: (SRRay origin: 2 @ 4 @ 0 forward: 0 @ 0 @ -1).
	self assert: hit object == self floorPortal.
	self assert: (hit point - (2 @ 4 @ -4)) length < 1.0e-4.
	self assert: (hit distance - 4) abs < 1.0e-4.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasPortalTest >> testAnEventReachesTheCanvasObjectWithACanvasPoint [
	| cube event |
	view canvasSpace addChild: (cube := SRCube new translation: 1 @ 2 @ 0; yourself).
	view translation: 0 @ 0 @ -5; scale: 2 asVector3.
	cube addDependent: self.
	event := SRInputEventButton new button: #trigger; pressed: true; point: 2 @ 4 @ -4; target: self floorPortal; yourself.
	[self floorPortal handleInput: event] ensure: [cube removeDependent: self].
	self assert: received size = 1.
	self assert: received first target == cube.
	self assert: (received first point - (1 @ 2 @ 0.5)) length < 1.0e-4.
	self assert: event handled.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasPortalTest >> testCanvasFeaturesLiveOutsideTheWorldTree [
	self assert: (view featureOf: SRRedawClipsFeature) parent == view canvasSpace.
	self assert: (view featureOf: SRRedawLayersFeature) parent == view.
	self assert: view canvasSpace parent isNil.
	self assert: view showsOnFloor.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasPortalTest >> testTheFloorCanBeSwitchedOff [
	view showOnFloor: false.
	self deny: view showsOnFloor.
	self assert: (view children noneSatisfy: [:each | each isKindOf: SRRedawCanvasPortal]).
	view showOnFloor: true.
	self assert: view showsOnFloor.
	self assert: (view children count: [:each | each isKindOf: SRRedawCanvasPortal]) = 1.
]

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:18'
}
SRRedawCanvasPortalTest >> update: anAspect with: anObject [
	anAspect == #inputReceived ifTrue: [received add: anObject].
]
