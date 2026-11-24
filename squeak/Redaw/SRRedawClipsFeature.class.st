"
The timeline's clips as blocks raised from the canvas: as wide as their duration, CLIP_HEIGHT (10 px) tall, top edge at their y.
"
Class {
	#name : #SRRedawClipsFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'placed',
		'signature',
		'segments',
		'projection',
		'batch'
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
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:26'
}
SRRedawClipsFeature >> layout [
	"A clip is a dark plate with one box per segment on it: colour as on the page, height from the vector length, depth from the movement."
	| m h all rmsRef motionRef |
	placed ifNil: [^ self].
	m := view metersPerPixel.
	h := view blockHeight.
	self addChild: (batch := SRRedawBoxBatch new opaque: true; yourself).
	all := placed inject: OrderedCollection new into: [:acc :a | (self segmentsOf: a key) ifNotNil: [:segs | acc addAll: segs]. acc].
	rmsRef := all inject: 0.001 into: [:max :seg | max max: (seg at: 2)].
	motionRef := all inject: 0.001 into: [:max :seg | max max: (seg at: 3)].
	placed do: [:a | | clip r p segs t |
		clip := a key.
		r := a value.
		p := view localPointFor: r center.
		segs := self segmentsOf: clip.
		batch at: p x @ p y @ 1mm extent: (r width * m) @ (r height * m) @ 2mm color: ((self colorFor: clip) mixed: 0.25 with: Color black).
		segs
			ifNil: [batch at: p x @ p y @ (h / 2) extent: (r width * m) @ (r height * m) @ h color: (self colorFor: clip)]
			ifNotNil: [
				t := 0.
				segs do: [:seg | | dur x z depth |
					dur := (seg at: 4) / clip rate.
					x := (view localPointFor: (r left + (t + (dur / 2) * view pixelsPerSecond)) @ r center y) x.
					z := h * (0.3 + (3 * (seg at: 2) / rmsRef)).
					depth := r height * m * (0.5 + (2 * (seg at: 3) / motionRef)).
					batch
						at: x @ p y @ (z / 2 + 2mm)
						extent: (dur * view pixelsPerSecond * m * 0.85) @ depth @ z
						color: (seg at: 1).
					t := t + dur]]]
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
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:26'
}
SRRedawClipsFeature >> projectionFor: aDim [
	"The page's fixed random projection to RGB (projection() in TimelineCanvas.jsx), so a sound has the same colour in both."
	| s a p |
	(projection notNil and: [projection first size = aDim]) ifTrue: [^ projection].
	s := 16r9E3779B9 bitXor: aDim.
	a := (3 / aDim) sqrt.
	p := (1 to: 3) collect: [:k | Float32Array new: aDim].
	1 to: 3 * aDim do: [:i |
		s := s * 1664525 + 1013904223 \\ 4294967296.
		(p at: i - 1 // aDim + 1) at: i - 1 \\ aDim + 1 put: s / 4294967296.0 * 2 - 1 * a].
	^ projection := p
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
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:26'
}
SRRedawClipsFeature >> segmentSeconds [
	^ 0.5
]

{
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:26'
}
SRRedawClipsFeature >> segmentsOf: aClip [
	"Per segment: the page's colour averaged over its frames, the mean vector length (small vectors sound quieter), and how far the latent moves from frame to frame. Clips sharing latents and rate share them."
	| frames key per p result |
	frames := aClip frames ifNil: [^ nil].
	frames isEmpty ifTrue: [^ nil].
	key := {aClip dataHash. aClip rate}.
	segments ifNil: [segments := Dictionary new].
	(segments at: key ifAbsent: [nil]) ifNotNil: [:cached | ^ cached].
	per := (aClip rate * self segmentSeconds) rounded max: 1.
	p := self projectionFor: frames first size.
	result := OrderedCollection new.
	1 to: frames size by: per do: [:start | | stop rgb rms motion |
		stop := start + per - 1 min: frames size.
		rgb := Array new: 3 withAll: 0.
		rms := motion := 0.
		start to: stop do: [:i | | f |
			f := frames at: i.
			1 to: 3 do: [:k | rgb at: k put: (rgb at: k) + (128 + (112 * ((p at: k) dot: f) tanh) / 255)].
			rms := rms + ((f dot: f) / f size) sqrt.
			i > 1 ifTrue: [ | delta |
				delta := f - (frames at: i - 1).
				motion := motion + ((delta dot: delta) / f size) sqrt]].
		result add: {
			Color r: (rgb at: 1) / (stop - start + 1) g: (rgb at: 2) / (stop - start + 1) b: (rgb at: 3) / (stop - start + 1).
			rms / (stop - start + 1).
			motion / (stop - start + 1).
			stop - start + 1}].
	^ segments at: key put: result asArray
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:26'
}
SRRedawClipsFeature >> update [
	| clips sig |
	clips := self session clips asArray.
	sig := clips collect: [:c | {c id. c t. c y. c rate. c length. c isLoaded}].
	sig = signature ifTrue: [^ false].
	signature := sig.
	placed := (clips collect: [:c | c -> (self footprintOf: c)]) select: [:a | a value notNil].
	^ true
]
