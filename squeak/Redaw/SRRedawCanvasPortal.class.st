"
Draws a canvas' canvas space through my transform, the way SRMiniView draws a subtree again: the canvas space (SRRedawSessionView>>canvasSpace) is kept out of the world tree, so it shows only where a portal draws it. The floor is one portal, an SRRedawCanvasWindow holds another and cuts it to its plate.

Input reaches the objects in canvas space through my collision geometry, which casts the ray there (see #worldHitFor:).
"
Class {
	#name : #SRRedawCanvasPortal,
	#superclass : #SRObject,
	#instVars : [
		'canvas',
		'clipper',
		'rendering'
	],
	#classVars : [
		'Active',
		'CanvasClip'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #clipping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:53'
}
SRRedawCanvasPortal class >> active [
	"The clipping portal being drawn, nil otherwise: the latent field asks it what to cut and what to skip."
	^ Active
]

{
	#category : #clipping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:53'
}
SRRedawCanvasPortal class >> clip [
	"Rows mapping world space onto the active portal's plate; zeros clip nothing. Both Raylib's batch and DrawMesh's matModel are in world space."
	^ CanvasClip ifNil: [CanvasClip := ByteArray new: 48]
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal class >> on: aSessionView [
	^ self new setCanvas: aSessionView
]

{
	#category : #shaders,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:13'
}
SRRedawCanvasPortal class >> redawClip [
	<shaderSource: #redawClip>
	"Raylib's default shader, discarding what lies outside a plate. The batch's vertices are in world space; clip rows map them onto the plate, inside within -0.5..0.5."
	^ {
		#uniforms -> #(clip).
		#vert -> '#version 450

layout(location = 0) in vec3 vertexPosition;
layout(location = 1) in vec2 vertexTexCoord;
layout(location = 3) in vec4 vertexColor;

layout(location = 0) uniform mat4 mvp;

layout(location = 0) out vec2 fragTexCoord;
layout(location = 1) out vec4 fragColor;
layout(location = 2) out vec3 fragPosition;

void main()
{
    fragTexCoord = vertexTexCoord;
    fragColor = vertexColor;
    fragPosition = vertexPosition;
    gl_Position = mvp * vec4(vertexPosition, 1.0);
}
'.
		#frag -> '#version 450

layout(location = 0) in vec2 fragTexCoord;
layout(location = 1) in vec4 fragColor;
layout(location = 2) in vec3 fragPosition;

layout(binding = 0) uniform sampler2D texture0;
layout(location = 2) uniform vec4 colDiffuse;
layout(location = 12) uniform vec4 clip[3];

layout(location = 0) out vec4 finalColor;

void main()
{
    vec4 p = vec4(fragPosition, 1.0);
    vec3 q = vec3(dot(clip[0], p), dot(clip[1], p), dot(clip[2], p));
    if (any(greaterThan(abs(q), vec3(0.5)))) discard;
    finalColor = texture(texture0, fragTexCoord) * colDiffuse * fragColor;
}
'
	} as: Dictionary
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> canvas [
	^ canvas
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:07'
}
SRRedawCanvasPortal >> canvasHitAt: aWorldPoint from: anOrigin [
	"The cursor's event has a point but no ray: cast again along the line from anOrigin through the point, as #worldHitFor: did, and answer the hit in canvas space."
	| toCanvas origin direction |
	toCanvas := self globalTransform inverseTransformation.
	origin := toCanvas localPointToGlobal: anOrigin.
	direction := (toCanvas localPointToGlobal: aWorldPoint) - origin.
	direction length < 1.0e-9 ifTrue: [^ nil].
	direction := direction normalized.
	((SRRay origin: origin forward: direction) castAll: self space) do: [:hit |
		(clipper isNil or: [clipper coversWorldPoint: (self globalTransform localPointToGlobal: hit point)])
			ifTrue: [^ hit]].
	^ nil
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:15'
}
SRRedawCanvasPortal >> canvasHitFor: anEvent [
	| origin |
	origin := self originOf: anEvent.
	(anEvent point isNil or: [origin isNil]) ifTrue: [^ nil].
	^ self canvasHitAt: anEvent point from: origin
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:53'
}
SRRedawCanvasPortal >> clippedDo: aBlock [
	| shader clip |
	(SRShader hasCachedShader: #redawClip) ifFalse: [^ aBlock value].
	shader := SRShader named: #redawClip.
	clip := self class clip.
	clip replaceFrom: 1 to: 48 with: (clipper clipRowsFor: Matrix4x4 identity) startingAt: 1.
	Active := self.
	Raylib
		setShaderValueVShader: shader internalShader locIndex: (shader uniformLocAt: #clip) value: clip uniformType: 3 count: 3;
		beginShaderModeShader: shader internalShader.
	aBlock ensure: [
		Raylib endShaderMode.
		Active := nil.
		clip atAllPut: 0]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> clipper [
	^ clipper
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> clipper: aCanvasWindow [
	clipper := aCanvasWindow.
	self grabTarget: aCanvasWindow.
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> collisionGeometry [
	(self space isNil or: [canvas isLaidOut not]) ifTrue: [^ nil].
	^ SRRedawPortalCollision new
		portal: self;
		object: self;
		yourself
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:15'
}
SRRedawCanvasPortal >> deliver: anEvent to: aHitOrNil [
	aHitOrNil ifNil: [^ false].
	aHitOrNil object handleInput: (anEvent copy
		target: aHitOrNil object;
		point: aHitOrNil point;
		handled: false;
		yourself).
	^ true
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:15'
}
SRRedawCanvasPortal >> dispatch: anEvent [
	"Hand anEvent to the canvas object under its point; answer whether there was one."
	^ self deliver: anEvent to: (self canvasHitFor: anEvent)
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:07'
}
SRRedawCanvasPortal >> handleInput: anEvent [
	"Events arrive with a point in the world; the canvas object under it gets them with the point in canvas space. In a window the trigger drags (see SRRedawCanvasWindow>>startDrag:) and the thumb stick pans and zooms."
	anEvent handled ifTrue: [^ self].
	clipper ifNotNil: [
		anEvent isAnalogEvent ifTrue: [^ clipper handleInput: anEvent].
		(anEvent isButtonEvent and: [anEvent button == #trigger]) ifTrue: [
			anEvent pressed ifTrue: [clipper takeFocus; startDrag: anEvent].
			^ anEvent handled: true]].
	(self dispatch: anEvent)
		ifTrue: [anEvent handled: true]
		ifFalse: [super handleInput: anEvent]
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> intersectsBoxCenter: aCentre halfExtents: aHalfExtents [
	"The floor canvas holds up whoever flies down onto it; a window's plate does that itself."
	| extent |
	(clipper notNil or: [canvas isNil or: [canvas isLaidOut not]]) ifTrue: [^ false].
	extent := canvas canvasExtent.
	^ (SRCollisionBox new
		center: (self globalTransform localPointToGlobal: 0 @ 0 @ -0.5cm);
		halfExtents: (extent x / 2) @ (extent y / 2) @ 0.5cm;
		rotation: self globalRotation;
		yourself) intersectsBoxCenter: aCentre halfExtents: aHalfExtents
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:07'
}
SRRedawCanvasPortal >> originOf: anEvent [
	"Where the line through the event's point starts: the hand's cursor ray (not the hand: on the desktop it is far from it), the camera, or else straight above the canvas. Analog events carry their action as the hand."
	| hand |
	hand := anEvent hand.
	(hand notNil and: [hand isKindOf: SRObject]) ifTrue: [
		(hand respondsTo: #cursor) ifTrue: [(hand cursor respondsTo: #redawRay) ifTrue: [^ hand cursor redawRay origin]].
		^ hand globalTranslation].
	self world ifNotNil: [:w | ^ w camera globalTranslation].
	^ self globalTransform localPointToGlobal: (self globalTransform globalPointToLocal: anEvent point) + (0 @ 0 @ 1)
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> renderObjectsOn: aRenderer [
	"As SRFrame does: an object that fails to draw is skipped from then on, and its error kept by the canvas."
	aRenderer withTransform: self globalTransform do: [
		rendering do: [:each |
			[each renderOn: aRenderer] on: Error do: [:e |
				each badRender: true.
				canvas noteError: e]]].
	rendering reset.
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> renderOn: aRenderer [
	| space |
	space := self space ifNil: [^ self].
	rendering reset.
	space allDo: [:each | each isRendering ifTrue: [rendering add: each]].
	clipper
		ifNil: [self renderObjectsOn: aRenderer]
		ifNotNil: [self clippedDo: [self renderObjectsOn: aRenderer]]
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> setCanvas: aSessionView [
	canvas := aSessionView.
	rendering := OrderedCollection new.
]

{
	#category : #clipping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:53'
}
SRRedawCanvasPortal >> showsCanvasRectFrom: aCorner to: anotherCorner [
	"Whether the canvas-space rectangle (in the canvas plane, corners as Vector3) reaches my clipper's plate. Without a clipper everything shows."
	| corners |
	clipper ifNil: [^ true].
	corners := {aCorner. anotherCorner. aCorner x @ anotherCorner y @ aCorner z. anotherCorner x @ aCorner y @ aCorner z}
		collect: [:each | self globalTransform localPointToGlobal: each].
	^ clipper overlapsWorldPoints: corners
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> space [
	^ canvas ifNotNil: [canvas canvasSpace]
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:10'
}
SRRedawCanvasPortal >> worldHitFor: aRay [
	"The nearest hit among the objects in canvas space, mapped back into the world; inside my clipper's plate only."
	| toCanvas origin direction |
	toCanvas := self globalTransform inverseTransformation.
	origin := toCanvas localPointToGlobal: aRay origin.
	direction := (toCanvas localDirToGlobal: aRay forward) normalized.
	((SRRay origin: origin forward: direction) castAll: self space) do: [:hit | | point |
		point := self globalTransform localPointToGlobal: hit point.
		(clipper isNil or: [clipper coversWorldPoint: point]) ifTrue: [
			^ SRIntersectionResult new
				object: self;
				point: point;
				distance: (point - aRay origin) length]].
	^ nil
]
