"
A RedawSession's timeline as an upright canvas in XR: the canvas is a flat plane in my XY plane, facing +z, and each clip a block raised from it towards the viewer.

The footprint follows the page's layout (live/app/timeline): time runs along +x at the page's default zoom of 100 px per second, the canvas' world y runs along -y (down, like on the screen), and a clip is as wide as its duration and CLIP_HEIGHT (10 px) tall, with its top edge at its y. Blocks protrude blockHeight along +z. metersPerPixel scales page pixels to metres; the plane covers the clips plus a margin and is centred on my origin.

	view := SRRedawSessionView link: '<invite link>'.
	view openInFront.
	view metersPerPixel: 1/1000.
	view session close. view remove.

I follow the session (started if it isn't running) and rebuild the blocks when a clip moves, appears or goes.
"
Class {
	#name : #SRRedawSessionView,
	#superclass : #SRObject,
	#instVars : [
		'session',
		'plane',
		'blocks',
		'signature',
		'metersPerPixel',
		'blockHeight'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView class >> link: aString [
	"Join the session of an invite link and show it."
	^ self on: (RedawSession link: aString)
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView class >> on: aRedawSession [
	^ self new session: aRedawSession; yourself
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> blockHeight: aNumber [
	blockHeight := aNumber.
	signature := nil
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> clipHeight [
	"CLIP_HEIGHT in clips.js, in page pixels."
	^ 10
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> colorFor: aRedawClip [
	^ Color h: (aRedawClip id hash \\ 360) s: 0.55 v: 0.95
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> footprintOf: aRedawClip [
	"The clip's rectangle on the page canvas, in pixels at the default zoom: x is time, y goes down."
	(aRedawClip t isNil or: [aRedawClip y isNil]) ifTrue: [^ nil].
	^ (aRedawClip t * self pixelsPerSecond) @ aRedawClip y
		extent: (aRedawClip duration * self pixelsPerSecond max: 1) @ self clipHeight
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> initialize [
	super initialize.
	metersPerPixel := 2 / 1000.
	blockHeight := 3cm.
	blocks := OrderedCollection new.
	plane := SRCube new
		drawWires: false;
		color: (Color gray: 0.22);
		yourself.
	self addChild: plane.
	self layout: #()
]

{
	#category : #layout,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:40'
}
SRRedawSessionView >> layout: clips [
	"Size the upright plane (XY, facing +z) to the clips' footprints and raise a block from it for each. Page y goes down, so it maps to -y."
	| placed bounds center m |
	m := metersPerPixel.
	placed := (clips collect: [:c | c -> (self footprintOf: c)]) select: [:a | a value notNil].
	bounds := placed isEmpty
		ifTrue: [0 @ 0 extent: 500 @ 250]
		ifFalse: [placed allButFirst inject: placed first value into: [:r :a | r merge: a value]].
	bounds := bounds expandBy: self margin.
	center := bounds center.
	plane
		scale: (bounds width * m) @ (bounds height * m) @ 1cm;
		translation: 0 @ 0 @ -0.5cm.
	blocks do: [:b | self removeChild: b].
	blocks removeAll.
	placed do: [:a | | r block |
		r := a value.
		block := SRCube new
			color: (self colorFor: a key);
			ignoreCollision: true;
			name: 'clip ', a key id asString;
			scale: (r width * m) @ (r height * m) @ blockHeight;
			translation: ((r center x - center x) * m) @ ((center y - r center y) * m) @ (blockHeight / 2);
			yourself.
		self addChild: block.
		blocks add: block]
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> margin [
	^ 40
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> metersPerPixel [
	^ metersPerPixel
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> metersPerPixel: aNumber [
	metersPerPixel := aNumber.
	signature := nil
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> pixelsPerSecond [
	"The page's default zoom (view.js), which fixes the aspect between time and canvas y."
	^ 100
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> session [
	^ session
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> session: aRedawSession [
	session := aRedawSession.
	session isRunning ifFalse: [session start].
	signature := nil
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> step: deltaTime [
	| clips sig |
	session ifNil: [^ self].
	clips := session clips asArray.
	sig := clips collect: [:c | {c id. c t. c y. c rate. c length}].
	sig = signature ifTrue: [^ self].
	signature := sig.
	self layout: clips
]
