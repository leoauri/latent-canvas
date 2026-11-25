"
Makes the world slow on purpose, to watch the headset's reprojection: every frame spins for #load milliseconds in the world process before it is submitted. Fast apps reach the refresh rate and never show it.

An SRPanel shows its -z side, the Redaw widgets their +z side: they sit on a face turned around.
"
Class {
	#name : #SRRedawLoadPanel,
	#superclass : #SRPanel,
	#instVars : [
		'face',
		'display',
		'slider',
		'drag',
		'load',
		'frameSeconds'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel class >> xrMenuOpen: aMenu [
	<xrMenu: #(world apps redaw) label: 'Load test (lower the frame rate)' priority: 40>
	| panel |
	panel := self new
		position: aMenu globalTranslation + (aMenu right * 45cm);
		yourself.
	aMenu world addChild: panel.
	panel globalRotation: (panel alignedRotationFor: aMenu world camera globalTranslation).
	^ panel
]

{
	#category : #menu,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> addCustomMenuItemsTo: aMenu [
	aMenu addItem: 'Close' action: [self world ifNotNil: [:w | w addDeferredFrameMessage: [self remove]]] keepOpen: false.
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> burn: milliseconds [
	"Spins instead of waiting on a Delay, like an app that is busy: the frame is late because the world process is."
	| deadline |
	deadline := Time utcMicrosecondClock + (milliseconds * 1000).
	[Time utcMicrosecondClock < deadline] whileTrue.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> collisionGeometry [
	^ SRCollisionBox new
		center: self globalTranslation;
		halfExtents: self size / 2;
		rotation: self globalRotation;
		object: self
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> contentWidth [
	^ self size x - 4cm
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> facePointOn: aRay [
	"Where aRay meets the plane of my face, global; nil if it runs along it or away from it."
	| toLocal origin direction t |
	toLocal := self globalTransform inverseTransformation.
	origin := toLocal localPointToGlobal: aRay origin.
	direction := toLocal localDirToGlobal: aRay forward.
	direction z abs < 1.0e-9 ifTrue: [^ nil].
	t := self size z / -2 - origin z / direction z.
	t < 0 ifTrue: [^ nil].
	^ self globalTransform localPointToGlobal: origin + (direction * t)
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> followDrag [
	"Runs every frame while the trigger is held: the slider follows where the ray meets my face."
	drag ifNil: [^ self].
	drag trigger isPressed ifFalse: [^ drag := nil].
	(self facePointOn: drag cursor redawRay) ifNotNil: [:point | slider trackAt: point].
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> initialize [
	| top |
	load := 0.
	super initialize.
	self name: 'Load test'.
	top := self size y / 2.
	self addChild: (SRCube new
		drawWires: false;
		color: (Color gray: 0.18);
		ignoreCollision: true;
		scale: self size;
		yourself).
	face := self addChild: (SRObject new
		cursorMode: SRCursorMode ignore;
		rotation: (Quaternion angle: 180 axis: Vector3 up);
		translation: 0 @ 0 @ (self size z / -2);
		yourself).
	display := face addChild: (self textField: 'Load test' scale: 1.4cm color: Color white).
	display position: (self contentWidth / -2) @ (top - 1.2cm) @ 1mm.
	(face addChild: (self textField: 'Busy work added to every frame' scale: 0.9cm color: (Color gray: 0.75)))
		position: (self contentWidth / -2) @ (top - 4cm) @ 1mm.
	slider := face addChild: ((SRRedawSlider
		width: self contentWidth
		from: 0
		to: 50
		get: [load]
		set: [:milliseconds | load := milliseconds]
		print: [:milliseconds | milliseconds printString, ' ms'])
			beInteger;
			grabTarget: self;
			translation: 0 @ (top - 5.4cm - (SRRedawSlider new height / 2)) @ 6mm;
			yourself).
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> load [
	^ load
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> load: milliseconds [
	load := milliseconds.
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> noteFrame: deltaTime [
	frameSeconds := frameSeconds
		ifNil: [deltaTime]
		ifNotNil: [frameSeconds * 0.9 + (deltaTime * 0.1)].
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> onButtonPress: anEvent [
	anEvent button == #trigger ifFalse: [^ self].
	(slider pressAt: anEvent point) == #drag ifTrue: [self startDrag: anEvent hand].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> size [
	^ 50cm @ 11cm @ 3cm
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> startDrag: aHand [
	((aHand isKindOf: SRHand) and: [aHand cursor respondsTo: #redawRay]) ifFalse: [^ self].
	drag := aHand.
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> status [
	(frameSeconds isNil or: [frameSeconds <= 0]) ifTrue: [^ 'Load test'].
	^ 'Load test: ', (1 / frameSeconds) rounded printString, ' fps, ', (frameSeconds * 1000 printShowingDecimalPlaces: 1), ' ms'
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> step: deltaTime [
	"Runs in the world process: an error here must not reach a debugger."
	[self followDrag.
	 slider refresh.
	 self noteFrame: deltaTime.
	 display text: self status]
		on: Error do: [:e |
			drag := nil.
			load := 0.
			display text: 'Load test: ', e messageText].
	self burn: load.
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:57'
}
SRRedawLoadPanel >> textField: aString scale: aNumber color: aColor [
	^ SRTextField new
		text: aString;
		color: aColor;
		scale: aNumber asVector3;
		rotation: SRTextField uprightRotation;
		yourself
]
