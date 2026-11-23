"
A transport of our own, as every page has (the page keeps its playhead per browser, not in the document): point at the canvas and pull the trigger to place the cue, the Play/Stop sign at the near edge plays from the cue and stops back at it.

The cursor moves every frame without a relayout; only the canvas changing rebuilds me.
"
Class {
	#name : #SRRedawPlayheadFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'cue',
		'time',
		'playing',
		'startedAt',
		'cursor',
		'cueMark',
		'sign'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> clear [
	super clear.
	cursor := cueMark := sign := nil
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:06'
}
SRRedawPlayheadFeature >> collisionGeometry [
	"A thin slab over the whole canvas, so pointing anywhere on it can place the cue. Raycasts run outside the view's step, also before the canvas is laid out."
	| extent |
	(cursor isNil or: [view isNil or: [view isLaidOut not]]) ifTrue: [^ nil].
	extent := view canvasExtent.
	^ SRCollisionBox new
		center: (self globalTransform localPointToGlobal: 0 @ 0 @ 1mm);
		halfExtents: (extent x / 2) @ (extent y / 2) @ 1mm;
		rotation: self globalRotation;
		object: self
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> cue [
	^ cue
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> initialize [
	super initialize.
	cue := 0.
	time := 0.
	playing := false
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> invalidate [
	cursor := nil
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> isPlaying [
	^ playing
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:58'
}
SRRedawPlayheadFeature >> layout [
	| m h depth |
	m := view metersPerPixel.
	h := view blockHeight.
	depth := view canvasExtent y.
	cursor := SRCube new
		drawWires: false;
		color: Color white;
		ignoreCollision: true;
		scale: (3 * m) @ depth @ (2 * h);
		yourself.
	cueMark := SRCube new
		drawWires: false;
		color: (Color r: 1 g: 0.85 b: 0.2);
		ignoreCollision: true;
		scale: (2 * m) @ depth @ (1.5 * h);
		yourself.
	sign := SRActionSign new
		label: 'Play';
		action: [self toggle];
		cursorMode: SRCursorMode pass;
		translation: 0 @ (depth / -2 - 12cm) @ 1cm;
		yourself.
	self addChild: cursor; addChild: cueMark; addChild: sign.
	self showState
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:58'
}
SRRedawPlayheadFeature >> onButtonPress: anEvent [
	| local |
	anEvent button == #trigger ifFalse: [^ self].
	(sign notNil and: [sign redawContains: anEvent point]) ifTrue: [^ sign redawPress].
	local := self globalTransform globalPointToLocal: anEvent point.
	self seek: (view pagePointFor: local) x / view pixelsPerSecond
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> play [
	time := cue.
	startedAt := Time millisecondClockValue.
	playing := true.
	self showState
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:05'
}
SRRedawPlayheadFeature >> refresh [
	"Built once per layout; afterwards I only move."
	(cursor isNil or: [view isLaidOut not]) ifTrue: [^ true].
	playing ifTrue: [time := cue + ((Time millisecondClockValue - startedAt) / 1000.0)].
	[self showState] on: Error do: [:e | lastError := e].
	^ false
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> seek: seconds [
	"While playing, playback jumps there, as in the page."
	cue := seconds.
	time := seconds.
	startedAt := Time millisecondClockValue.
	self showState
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:05'
}
SRRedawPlayheadFeature >> showState [
	| h |
	(cursor isNil or: [view isLaidOut not]) ifTrue: [^ self].
	h := view blockHeight.
	cursor translation: (self xAt: time) @ 0 @ h.
	cueMark translation: (self xAt: cue) @ 0 @ (0.75 * h).
	cueMark visible: playing.
	sign label: (playing ifTrue: ['Stop'] ifFalse: ['Play'])
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> stop [
	playing := false.
	time := cue.
	self showState
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> time [
	^ time
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> toggle [
	playing ifTrue: [self stop] ifFalse: [self play]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> update [
	^ false
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawPlayheadFeature >> xAt: seconds [
	^ (view localPointFor: (view pagePointAt: seconds y: 0)) x
]
