"
The canvas on a plate, a sand table to carry around: a portal of my canvas, panned and zoomed, cut to my plate. Only the plate's outline cuts; what stands on the canvas (columns, sheets, labels) rises above it freely.

Grab the plate to carry it. Thumb stick while pointing at it: sideways pans along time, forward and back zooms about the point aimed at; the mouse wheel zooms too.
"
Class {
	#name : #SRRedawCanvasWindow,
	#superclass : #SRObject,
	#instVars : [
		'canvas',
		'portal',
		'zoom',
		'center',
		'follow',
		'display',
		'frame',
		'lastAnalog',
		'drag',
		'extent',
		'plate',
		'buttons',
		'resizers',
		'number',
		'marker',
		'painter'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow class >> for: aSessionView [
	^ self new setCanvas: aSessionView
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindow >> addButton: aString do: aBlock [
	"The button passes the trigger on to me, I find the button under the hit point. #layoutPlate places it."
	| button |
	button := SRActionSign new
		size: 9cm @ 4.5cm @ 1.5cm;
		label: aString;
		slabColor: (aString = 'Rec' ifTrue: [Color r: 0.6 g: 0.12 b: 0.12] ifFalse: [Color r: 0.15 g: 0.35 b: 0.6]);
		action: aBlock;
		grabTarget: self;
		cursorMode: SRCursorMode pass;
		rotation: self buttonRotation;
		yourself.
	^ self addChild: button
]

{
	#category : #menus,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:27'
}
SRRedawCanvasWindow >> addCustomMenuItemsTo: aMenu [
	aMenu addItem: 'Fit the canvas' action: [self fit] keepOpen: true.
	aMenu addItem: 'Close ', self title action: [canvas ifNotNil: [canvas closeWindow: self]] keepOpen: false.
	canvas ifNotNil: [canvas addCustomMenuItemsTo: aMenu]
]

{
	#category : #resizing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindow >> addResizers [
	resizers := SRResizer corners collect: [:corner |
		self addChild: (SRRedawPlateResizer new
			panel: self;
			corner: corner;
			yourself)].
	self snapResizers.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> analogStep [
	"Seconds since the last stick event: they come once a frame while the stick is pushed."
	| now dt |
	now := Time millisecondClockValue.
	dt := lastAnalog ifNil: [0] ifNotNil: [now - lastAnalog / 1000.0].
	lastAnalog := now.
	^ (dt between: 0 and: 0.1) ifTrue: [dt] ifFalse: [1 / 90]
]

{
	#category : #marker,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:54'
}
SRRedawCanvasWindow >> attachMarker [
	"My region drawn on the canvas itself, so the floor and the other maps show where I look."
	marker ifNotNil: [^ self].
	marker := SRObject new name: self title, ' region'; yourself.
	marker addChild: (SRRedawMapMarker new color: self color; yourself).
	marker addChild: (SRTextField new
		text: self title;
		color: self color;
		rotation: SRTextField uprightRotation;
		yourself).
	canvas canvasSpace addChild: marker.
	self updateMarker.
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:27'
}
SRRedawCanvasWindow >> buildFrame [
	"A rim in my colour marks the edge that cuts."
	| w d c t |
	w := self size x.
	d := self size y.
	t := 8mm.
	c := self color alpha: 0.8.
	frame clear.
	frame at: 0 @ 0 @ (d / 2) extent: w @ t @ t color: c.
	frame at: 0 @ 0 @ (d / -2) extent: w @ t @ t color: c.
	frame at: (w / 2) @ 0 @ 0 extent: t @ t @ d color: c.
	frame at: (w / -2) @ 0 @ 0 extent: t @ t @ d color: c.
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> buttonRotation [
	"Leaning back a little, read from in front of the plate."
	^ Quaternion angle: -30 axis: Vector3 right
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> buttonSpecs [
	^ {
		{'Play'. [canvas ifNotNil: [canvas togglePlay]]}.
		{'Rec'. [canvas ifNotNil: [canvas toggleRecording]]}.
		{'Paint'. [self togglePaint]}.
		{'Undo'. [self undoPaint]}.
		{'-'. [self zoomBy: 1 / 1.5 at: nil]}.
		{'+'. [self zoomBy: 1.5 at: nil]}.
		{'Fit'. [self fit]}.
		{'Follow'. [self toggleFollow]}.
		{'<'. [self stopFollowing. self panBy: -0.4 @ 0]}.
		{'>'. [self stopFollowing. self panBy: 0.4 @ 0]}.
		{'Floor'. [canvas ifNotNil: [canvas toggleFloor]]}.
		{'New map'. [canvas ifNotNil: [canvas newWindow]]}.
		{'Close'. [canvas ifNotNil: [canvas closeWindow: self]]}}
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> canvas [
	^ canvas
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> canvasHeight [
	"Above the plate, so the sheets below the canvas do not sink into it at once."
	^ 3cm
]

{
	#category : #dragging,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:06'
}
SRRedawCanvasWindow >> canvasPointOn: aRay [
	"Where aRay meets the canvas plane, in canvas coordinates; nil if it runs along it or away from it."
	| toCanvas origin direction t hit |
	toCanvas := portal globalTransform inverseTransformation.
	origin := toCanvas localPointToGlobal: aRay origin.
	direction := toCanvas localDirToGlobal: aRay forward.
	direction z abs < 1.0e-9 ifTrue: [^ nil].
	t := origin z negated / direction z.
	t < 0 ifTrue: [^ nil].
	hit := origin + (direction * t).
	^ hit x @ hit y
]

{
	#category : #marker,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:27'
}
SRRedawCanvasWindow >> canvasRect [
	"The part of the canvas on my plate, in the canvas' local coordinates."
	| half |
	half := (self size x / 2 / zoom) @ (self size y / 2 / zoom).
	^ (center - half) corner: (center + half)
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> center [
	^ center
]

{
	#category : #clipping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> clipRowsFor: aMatrix [
	"Rows mapping a point through aMatrix onto my plate as fractions of its size, inside while both lie within -0.5..0.5. The middle row stays zero: only the outline cuts, what stands on the canvas rises freely."
	| m rows |
	m := self globalTransform inverseTransformation composedWithLocal: aMatrix.
	rows := ByteArray new: 48.
	{m a11. m a12. m a13. m a14} doWithIndex: [:v :i | rows floatAt: i - 1 * 4 + 1 put: v / self size x].
	{m a31. m a32. m a33. m a34} doWithIndex: [:v :i | rows floatAt: i - 1 * 4 + 33 put: v / self size y].
	^ rows
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> collisionGeometry [
	^ SRCollisionBox new
		center: (self globalTransform localPointToGlobal: 0 @ -0.8cm @ 0);
		halfExtents: (self size x / 2 + 2cm) @ 0.75cm @ (self size y / 2 + 2cm);
		rotation: self globalRotation;
		object: self
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:27'
}
SRRedawCanvasWindow >> color [
	"Rim and region marker share it, so a map can be found on the floor."
	^ Color h: (self number - 1 * 137 + 40) \\ 360 s: 0.75 v: 1.0
]

{
	#category : #clipping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> coversWorldPoint: aPoint [
	| local |
	local := self globalTransform globalPointToLocal: aPoint.
	^ local x abs <= (self size x / 2) and: [local z abs <= (self size y / 2)]
]

{
	#category : #marker,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:27'
}
SRRedawCanvasWindow >> detachMarker [
	marker ifNotNil: [marker remove].
	marker := nil.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:15'
}
SRRedawCanvasWindow >> endDrag [
	"Released without moving: the press was a click, for the canvas object under it, unless #startDrag: already gave it to the cue."
	| press |
	press := drag second.
	((drag at: 4) not and: [press notNil]) ifTrue: [portal dispatch: press].
	drag := nil.
]

{
	#category : #resizing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindow >> extent: aPoint [
	| min new |
	min := SRRedawPlateResizer minimumExtent.
	new := ((aPoint x max: min x) min: 4m) @ ((aPoint y max: min y) min: 3m).
	new = self size ifTrue: [^ self].
	extent := new.
	self layoutPlate.
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> fit [
	(canvas notNil and: [canvas isLaidOut]) ifFalse: [^ self].
	zoom := self fitZoom.
	center := 0 @ 0.
	follow := false.
	self layoutPortal.
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> fitZoom [
	| extent |
	extent := canvas canvasExtent.
	^ (self size x / extent x) min: (self size y / extent y)
]

{
	#category : #dragging,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> followDrag [
	"Runs every frame while the trigger is held: once the point under the ray has moved a centimetre on the plate, the canvas follows the ray."
	| hand ray anchor point |
	(painter notNil and: [painter isDrawing]) ifTrue: [^ painter follow].
	drag ifNil: [^ self].
	hand := drag first.
	hand trigger isPressed ifFalse: [^ self endDrag].
	ray := hand cursor redawRay.
	anchor := (drag at: 3) ifNil: [^ drag at: 3 put: (self canvasPointOn: ray)].
	(drag at: 4) ifFalse: [
		point := (self canvasPointOn: ray) ifNil: [^ self].
		(point - anchor) r * zoom < 1cm ifTrue: [^ self].
		drag at: 4 put: true.
		follow := false].
	self keep: anchor under: ray.
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> followPlayhead [
	| x |
	x := (canvas localPointFor: (canvas pagePointAt: canvas playheadTime y: 0)) x.
	x = center x ifTrue: [^ self].
	center := x @ center y.
	self layoutPortal.
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:06'
}
SRRedawCanvasWindow >> hasFocus [
	^ self world notNil and: [self world keyboardFocus == self]
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:06'
}
SRRedawCanvasWindow >> holdsStick [
	^ self hasFocus
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindow >> initialize [
	super initialize.
	self name: 'Redaw canvas window'.
	zoom := 0.01.
	center := 0 @ 0.
	follow := false.
	self addChild: (plate := SRCube new
		drawWires: false;
		color: (Color gray: 0.12);
		ignoreCollision: true;
		yourself).
	self addChild: (frame := SRRedawBoxBatch new).
	self addChild: (display := SRTextField new
		text: 'Redaw window';
		color: Color white;
		scale: 1.5cm asVector3;
		rotation: SRTextField uprightRotation * self buttonRotation;
		yourself).
	buttons := self buttonSpecs collect: [:spec | self addButton: spec first do: spec second].
	self addResizers.
	self layoutPlate.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> isApp [
	^ true
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> isFollowing [
	^ follow
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> isPainting [
	^ painter notNil
]

{
	#category : #dragging,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:06'
}
SRRedawCanvasWindow >> keep: aCanvasPoint under: aRay [
	"Pan so that aCanvasPoint lies where aRay meets the canvas."
	| point |
	point := (self canvasPointOn: aRay) ifNil: [^ self].
	center := center + (aCanvasPoint - point).
	self layoutPortal.
]

{
	#category : #resizing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindow >> keepCanvasWhile: aBlock [
	"Resizing moves my centre; the canvas stays where it lies in the world."
	| before shift |
	before := self globalTranslation.
	aBlock value.
	shift := self globalTransform globalDirToLocal: self globalTranslation - before.
	center := center + ((shift x / zoom) @ (shift z negated / zoom)).
	self layoutPortal.
]

{
	#category : #resizing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:54'
}
SRRedawCanvasWindow >> layoutPlate [
	"Plate, rim, and the buttons in as many rows along the front edge as the width needs."
	| perRow |
	plate
		scale: (self size x + 4cm) @ 1.5cm @ (self size y + 4cm);
		translation: 0 @ -0.8cm @ 0.
	self buildFrame.
	perRow := ((self size x + 4cm) / 9.8cm) floor max: 1.
	buttons doWithIndex: [:button :i | | row column count |
		row := i - 1 // perRow.
		column := i - 1 \\ perRow.
		count := perRow min: buttons size - (row * perRow).
		button translation: (column - (count - 1 / 2)) * 9.8cm @ 3cm @ (self size y / 2 + 4cm + (row * 6cm))].
	display position: (self size x / -2 + 1cm) @ 8.5cm @ (self size y / 2 + 1cm).
	self snapResizers.
	self updateMarker.
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:54'
}
SRRedawCanvasWindow >> layoutPortal [
	"My centre shows the canvas point center; canvas y runs away from the front edge, canvas z up. The marker moves with it, in the same frame."
	portal ifNil: [^ self].
	portal
		rotation: (Quaternion angle: -90 axis: Vector3 right);
		scale: zoom asVector3;
		translation: (center x * zoom) negated @ self canvasHeight @ (center y * zoom).
	self updateMarker.
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:02'
}
SRRedawCanvasWindow >> maxZoom [
	"Eight times the floor: a latent frame, 2.7 mm on the floor, is 2 cm wide on the plate."
	^ 8
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:27'
}
SRRedawCanvasWindow >> number [
	^ number ifNil: [1]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:27'
}
SRRedawCanvasWindow >> number: anInteger [
	number := anInteger.
	self buildFrame.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:06'
}
SRRedawCanvasWindow >> onAnalogInput: anEvent [
	"Once a trigger press gave me focus, the stick pans sideways along time and zooms forward and back, as the wheel does."
	| dt value |
	value := anEvent value.
	anEvent axis == #wheel ifTrue: [| n |
		n := value isNumber ifTrue: [value] ifFalse: [value y].
		n isZero ifFalse: [self zoomBy: (1.2 raisedTo: n sign) at: anEvent point].
		^ anEvent handled: true].
	(anEvent axis == #joystick and: [self hasFocus]) ifFalse: [^ self].
	dt := self analogStep.
	value x abs > 0.15 ifTrue: [
		follow := false.
		self panBy: (value x * dt * 0.8) @ 0].
	value y abs > 0.15 ifTrue: [self zoomBy: (2 raisedTo: value y * dt * 1.5) at: anEvent point].
	anEvent handled: true.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:06'
}
SRRedawCanvasWindow >> onButtonPress: anEvent [
	"My buttons react at once; elsewhere on the plate the trigger drags."
	anEvent button == #trigger ifFalse: [^ self].
	self takeFocus.
	(self children
		detect: [:each | (each isKindOf: SRActionSign) and: [each redawContains: anEvent point]]
		ifNone: [nil])
			ifNil: [self startDrag: anEvent]
			ifNotNil: [:button | button redawPress]
]

{
	#category : #clipping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:53'
}
SRRedawCanvasWindow >> overlapsWorldPoints: points [
	"Whether the rectangle spanned by points, seen from above, reaches my plate."
	| locals |
	locals := points collect: [:each | self globalTransform globalPointToLocal: each].
	^ ((locals inject: Float infinity into: [:m :p | m min: p x]) <= (self size x / 2))
		and: [((locals inject: Float infinity negated into: [:m :p | m max: p x]) >= (self size x / -2))
		and: [((locals inject: Float infinity into: [:m :p | m min: p z]) <= (self size y / 2))
		and: [(locals inject: Float infinity negated into: [:m :p | m max: p z]) >= (self size y / -2)]]]
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> painter [
	^ painter
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> panBy: aFraction [
	"aFraction of my plate: x along time, y away from the front edge."
	center := center + ((aFraction x * self size x / zoom) @ (aFraction y * self size y / zoom)).
	self layoutPortal.
]

{
	#category : #opening,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:08'
}
SRRedawCanvasWindow >> placeInFrontOf: aCamera [
	"Below the hands, so their rays reach the canvas from above: on the desktop the hand is about 60 cm below the eye."
	| forward ahead toward yaw position |
	forward := aCamera forward.
	ahead := (Vector3 x: forward x y: 0 z: forward z) normalize.
	position := aCamera globalTranslation + (ahead * 75cm) + (0 @ -80cm @ 0).
	toward := aCamera globalTranslation - position.
	yaw := (toward x arcTan: toward z) radiansToDegrees.
	self rotation: (Quaternion angle: yaw axis: Vector3 up).
	self translation: position.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> portal [
	^ portal
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:02'
}
SRRedawCanvasWindow >> roundedForScale: aNumber [
	aNumber >= 10 ifTrue: [^ aNumber rounded printString].
	^ aNumber printShowingMaxDecimalPlaces: 1
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:02'
}
SRRedawCanvasWindow >> scaleText [
	"One decimal where whole numbers would hide the difference, below 1:10; a map that magnifies reads the other way round."
	| ratio |
	zoom > 1 ifTrue: [^ (self roundedForScale: zoom), ':1'].
	ratio := 1 / zoom.
	^ '1:', (self roundedForScale: ratio)
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:06'
}
SRRedawCanvasWindow >> setCanvas: aSessionView [
	canvas := aSessionView.
	portal := SRRedawCanvasPortal on: aSessionView.
	portal clipper: self.
	self addChild: portal.
	self layoutPortal.
	canvas isLaidOut ifTrue: [self fit].
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindow >> showLabel: aString on: aButton [
	aButton label = aString ifFalse: [aButton label: aString]
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> showStatus [
	| half left right text |
	half := self size x / 2 / zoom.
	left := (canvas pagePointFor: (center x - half) @ 0) x / canvas pixelsPerSecond.
	right := (canvas pagePointFor: (center x + half) @ 0) x / canvas pixelsPerSecond.
	text := self title, '  ', self scaleText, '  ', (SRRedawTransport clock: left), ' - ', (SRRedawTransport clock: right), (follow ifTrue: ['  follow'] ifFalse: ['']), (self isPainting ifTrue: ['  paint'] ifFalse: ['']), (self hasFocus ifTrue: ['  stick'] ifFalse: ['']).
	text = display text ifFalse: [display text: text].
	self showLabel: (canvas isPlaying ifTrue: ['Stop'] ifFalse: ['Play']) on: buttons first.
	self showLabel: (canvas isRecording ifTrue: ['Stop rec'] ifFalse: [canvas isRecordArmed ifTrue: ['Armed'] ifFalse: ['Rec']]) on: buttons second.
	buttons size > 2 ifTrue: [self showLabel: (self isPainting ifTrue: ['Stop paint'] ifFalse: ['Paint']) on: buttons third].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindow >> size [
	"The plate: along time, and across the canvas' lanes."
	^ extent ifNil: [80cm @ 50cm]
]

{
	#category : #resizing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:24'
}
SRRedawCanvasWindow >> snapResizers [
	resizers ifNotNil: [resizers do: [:each | each snapToCorner]]
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:16'
}
SRRedawCanvasWindow >> startDrag: anEvent [
	| hand |
	hand := anEvent hand.
	((hand isKindOf: SRHand) and: [hand cursor respondsTo: #redawRay]) ifFalse: [^ portal dispatch: anEvent].
	self startDrag: anEvent by: hand along: hand cursor redawRay.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> startDrag: anEvent by: aHand along: aRay [
	"A trigger press on the plate or its canvas. Moving it pans. On the cue's ground the press places the cue at once, so a hand that moves a little still cues where it pressed; anything else gets the press on release, and only if it did not move (see #endDrag). In paint mode it starts a stroke instead."
	| press hit |
	painter ifNotNil: [^ painter start: aHand along: aRay].
	press := anEvent.
	hit := portal canvasHitFor: anEvent.
	(hit notNil and: [hit object redawPlacesCueAt: hit point]) ifTrue: [
		portal deliver: anEvent to: hit.
		press := nil].
	drag := {aHand. press. self canvasPointOn: aRay. false}
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> step: deltaTime [
	"Runs in the world process: an error here must not reach a debugger."
	[(canvas isNil or: [canvas isLaidOut not]) ifTrue: [^ self].
	 self followDrag.
	 follow ifTrue: [self followPlayhead].
	 self showStatus]
		on: Error do: [:e |
			drag := nil.
			painter ifNotNil: [painter cancel].
			display text: 'Window: ', e messageText]
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> stopFollowing [
	follow := false.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:06'
}
SRRedawCanvasWindow >> takeFocus [
	self world ifNotNil: [:w | w keyboardFocus: self].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:27'
}
SRRedawCanvasWindow >> title [
	^ 'Map ', self number printString
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> toggleFollow [
	follow := follow not.
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> togglePaint [
	"While painting, a trigger drag paints instead of panning; the stick and the wheel still pan and zoom."
	painter ifNil: [
		canvas ifNotNil: [canvas enable: SRRedawPaintFeature].
		painter := SRRedawMapPainter on: self.
		^ true].
	painter finish.
	painter := nil.
	^ false
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawCanvasWindow >> undoPaint [
	^ canvas ifNotNil: [(canvas featureOf: SRRedawPaintFeature) ifNotNil: [:f | f undo]]
]

{
	#category : #marker,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:02'
}
SRRedawCanvasWindow >> updateMarker [
	| r |
	marker ifNil: [^ self].
	r := self canvasRect.
	marker children first rect: r.
	marker children second
		text: self title, '  ', self scaleText;
		scale: 25cm asVector3;
		position: r left @ (r top - 5cm) @ 2cm.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> wantsGrab [
	^ true
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:11'
}
SRRedawCanvasWindow >> zoom [
	^ zoom
]

{
	#category : #viewing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:02'
}
SRRedawCanvasWindow >> zoomBy: aFactor at: aWorldPointOrNil [
	"The canvas point under aWorldPointOrNil, or my centre, stays where it is."
	| newZoom factor anchor |
	(canvas notNil and: [canvas isLaidOut]) ifFalse: [^ self].
	newZoom := zoom * aFactor min: self maxZoom max: self fitZoom / 2.
	factor := newZoom / zoom.
	anchor := (aWorldPointOrNil isNil or: [follow])
		ifTrue: [center]
		ifFalse: [| p | p := portal globalTransform globalPointToLocal: aWorldPointOrNil. p x @ p y].
	zoom := newZoom.
	center := anchor + ((center - anchor) / factor).
	self layoutPortal.
]
