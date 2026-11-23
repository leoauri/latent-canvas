"
The timeline's clips as blocks raised from the canvas: as wide as their duration, CLIP_HEIGHT (10 px) tall, top edge at their y.
"
Class {
	#name : #SRRedawClipsFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'placed',
		'signature'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'page layout',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawClipsFeature >> colorFor: aRedawClip [
	^ Color h: (aRedawClip id hash \\ 360) s: 0.55 v: 0.95
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawClipsFeature >> footprintOf: aRedawClip [
	"The clip's rectangle on the page canvas, in pixels at the default zoom: x is time, y goes down."
	(aRedawClip t isNil or: [aRedawClip y isNil]) ifTrue: [^ nil].
	^ (view pagePointAt: aRedawClip t y: aRedawClip y)
		extent: (aRedawClip duration * view pixelsPerSecond max: 1) @ view clipHeight
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawClipsFeature >> invalidate [
	signature := nil
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawClipsFeature >> layout [
	| m h |
	placed ifNil: [^ self].
	m := view metersPerPixel.
	h := view blockHeight.
	placed do: [:a | | r p |
		r := a value.
		p := view localPointFor: r center.
		self addChild: (SRCube new
			color: (self colorFor: a key);
			ignoreCollision: true;
			name: 'clip ', a key id asString;
			scale: (r width * m) @ (r height * m) @ h;
			translation: p x @ p y @ (h / 2);
			yourself)]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawClipsFeature >> pageBounds [
	(placed isNil or: [placed isEmpty]) ifTrue: [^ nil].
	^ placed allButFirst inject: placed first value into: [:r :a | r merge: a value]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawClipsFeature >> refresh [
	"Clips are updated in place, also after the document changed, as their latents arrive: compare what places them every frame."
	^ [self update] on: Error do: [:e | lastError := e. false]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawClipsFeature >> update [
	| clips sig |
	clips := self session clips asArray.
	sig := clips collect: [:c | {c id. c t. c y. c rate. c length}].
	sig = signature ifTrue: [^ false].
	signature := sig.
	placed := (clips collect: [:c | c -> (self footprintOf: c)]) select: [:a | a value notNil].
	^ true
]
