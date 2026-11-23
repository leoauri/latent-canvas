"
The controls of one Redaw canvas, a handheld remote: grab it (anywhere on it) to carry it along, pull the trigger on a button to press it. Play/Stop works as Space in the page, Tour jumps the cue to the next tour note, Canvas lays the canvas down ahead of you. Made by its canvas (SRRedawSessionView>>transport) and removed with it.
"
Class {
	#name : #SRRedawTransport,
	#superclass : #SRObject,
	#instVars : [
		'playButton',
		'display',
		'canvas'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport class >> for: aSessionView [
	^ self new setCanvas: aSessionView
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:58'
}
SRRedawTransport >> addButton: aString at: x do: aBlock [
	"The button passes the trigger on to me, I find the button under the hit point."
	| button |
	button := SRActionSign new
		size: 9cm @ 4.5cm @ 1.5cm;
		label: aString;
		slabColor: (Color r: 0.15 g: 0.35 b: 0.6);
		action: aBlock;
		grabTarget: self;
		cursorMode: SRCursorMode pass;
		translation: x @ -3cm @ (self size z / 2 + 0.75cm);
		yourself.
	self addChild: button.
	^ button
]

{
	#category : #'app menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport >> addCustomMenuItemsTo: aMenu [
	"The same menu as my canvas'."
	canvas ifNotNil: [canvas addCustomMenuItemsTo: aMenu]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport >> canvas [
	^ canvas
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:58'
}
SRRedawTransport >> clock: seconds [
	| s |
	s := seconds abs.
	^ (seconds < 0 ifTrue: ['-'] ifFalse: ['']), (s // 60) printString, ':', ((s \\ 60) floor printPaddedWith: $0 to: 2), '.', (s \\ 1 * 10) floor printString
]

{
	#category : #grabbing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:42'
}
SRRedawTransport >> collisionGeometry [
	^ SRCollisionBox new
		center: self globalTranslation;
		halfExtents: self size / 2;
		rotation: self globalRotation;
		object: self
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport >> initialize [
	super initialize.
	self name: 'Redaw controls'.
	self addChild: (SRCube new
		drawWires: false;
		color: (Color gray: 0.18);
		ignoreCollision: true;
		scale: self size;
		yourself).
	display := SRTextField new
		text: 'Redaw';
		color: Color white;
		scale: 1.6cm asVector3;
		rotation: SRTextField uprightRotation;
		position: (self size x / -2 + 1.5cm) @ (self size y / 2 - 1.5cm) @ (self size z / 2 + 1mm);
		yourself.
	self addChild: display.
	playButton := self addButton: 'Play' at: -9.5cm do: [canvas ifNotNil: [canvas togglePlay]].
	self addButton: 'Tour >' at: 0 do: [canvas ifNotNil: [canvas nextTourStop]].
	self addButton: 'Canvas' at: 9.5cm do: [canvas ifNotNil: [canvas layOnFloor]]
]

{
	#category : #'app menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport >> isApp [
	^ true
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:58'
}
SRRedawTransport >> onButtonPress: anEvent [
	anEvent button == #trigger ifFalse: [^ self].
	(self children
		detect: [:each | (each isKindOf: SRActionSign) and: [each redawContains: anEvent point]]
		ifNone: [nil]) ifNotNil: [:button | button redawPress]
]

{
	#category : #opening,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport >> placeAt: aPosition facing: aCamera [
	| toward yaw |
	toward := aCamera globalTranslation - aPosition.
	yaw := (toward x arcTan: toward z) radiansToDegrees.
	self rotation: (Quaternion angle: yaw axis: Vector3 up).
	self translation: aPosition
]

{
	#category : #opening,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport >> placeInFrontOf: aCamera [
	"At hand height, half a metre ahead."
	| forward ahead |
	forward := aCamera forward.
	ahead := (Vector3 x: forward x y: 0 z: forward z) normalize.
	self placeAt: aCamera globalTranslation + (ahead * 45cm) + (0 @ -35cm @ 0) facing: aCamera
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport >> playhead [
	^ canvas ifNotNil: [canvas featureOf: SRRedawPlayheadFeature]
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawTransport >> setCanvas: aSessionView [
	canvas := aSessionView
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:42'
}
SRRedawTransport >> size [
	^ 30cm @ 15cm @ 3cm
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:42'
}
SRRedawTransport >> step: deltaTime [
	"Runs in the world process: an error here must not reach a debugger."
	[| playhead |
	 playhead := self playhead.
	 playButton label: ((playhead notNil and: [playhead isPlaying]) ifTrue: ['Stop'] ifFalse: ['Play']).
	 display text: (playhead
		ifNil: ['Redaw: no canvas']
		ifNotNil: ['Redaw  ', (self clock: playhead time), (playhead isPlaying ifTrue: ['  playing'] ifFalse: ['  cue'])])]
			on: Error do: [:e | display text: 'Redaw: ', e messageText]
]

{
	#category : #grabbing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:42'
}
SRRedawTransport >> wantsGrab [
	^ true
]
