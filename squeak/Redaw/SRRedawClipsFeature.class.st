"
The timeline's clips as blocks raised from the canvas: as wide as their duration, CLIP_HEIGHT (10 px) tall, top edge at their y.
"
Class {
	#name : #SRRedawClipsFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'placed',
		'signature',
		'projection',
		'batch',
		'strips',
		'stats',
		'style',
		'field'
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
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:34'
}
SRRedawClipsFeature >> deactivate [
	self releaseStripsExcept: #().
	strips := nil.
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
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:34'
}
SRRedawClipsFeature >> framesPerStrip [
	"Mesh indices are 16 bit: at 20 vertices a frame, a mesh holds 3276 frames."
	^ 3000
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
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:34'
}
SRRedawClipsFeature >> layout [
	"A clip is a dark plate with a column per latent frame on it; one SRRedawLatentField draws all columns."
	| m h used |
	placed ifNil: [^ self].
	m := view metersPerPixel.
	h := view blockHeight.
	self addChild: (batch := SRRedawBoxBatch new opaque: true; yourself).
	self statsOf: (placed collect: [:each | each key]).
	(stats notNil and: [(SRShader hasCachedShader: #redawLatent) not and: [SRShader canTranspile]])
		ifTrue: [SRShader transpileShaderNamed: #redawLatent].
	field := SRRedawLatentField new style: self style; stats: stats; yourself.
	self addChild: field.
	used := Set new.
	placed do: [:each | | clip r p depth list left |
		clip := each key.
		r := each value.
		p := view localPointFor: r center.
		depth := r height * m.
		batch at: p x @ p y @ 1mm extent: (r width * m) @ depth @ 2mm color: ((self colorFor: clip) mixed: 0.25 with: Color black).
		list := self stripsOf: clip depth: depth.
		list
			ifNil: [batch at: p x @ p y @ (h / 2) extent: (r width * m) @ depth @ h color: (self colorFor: clip)]
			ifNotNil: [
				used add: (self stripKeyOf: clip depth: depth).
				left := (view localPointFor: r left @ r center y) x.
				list do: [:strip | field add: strip at: left + strip offset @ p y @ 2mm]]].
	self releaseStripsExcept: used.
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
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:34'
}
SRRedawClipsFeature >> releaseStripsExcept: usedKeys [
	strips ifNil: [^ self].
	(strips keys reject: [:each | usedKeys includes: each]) do: [:each |
		(strips removeKey: each) do: [:strip | strip unload]]
]

{
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:34'
}
SRRedawClipsFeature >> statsOf: clips [
	| arrays |
	arrays := Dictionary new.
	clips do: [:each | (each frames notNil and: [each frames notEmpty]) ifTrue: [
		arrays at: {each dataHash. each rate} put: each frames]].
	arrays isEmpty ifTrue: [^ stats := nil].
	(stats notNil and: [stats key = arrays keys asSet]) ifTrue: [^ stats].
	stats := SRRedawLatentStats of: arrays values.
	stats key: arrays keys asSet.
	self style dims: stats dims.
	^ stats
]

{
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:34'
}
SRRedawClipsFeature >> stripKeyOf: aClip depth: aDepth [
	^ {aClip dataHash. aClip rate. aDepth}
]

{
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:34'
}
SRRedawClipsFeature >> stripsOf: aClip depth: aDepth [
	"Clips sharing latents and rate share their strips."
	| frames |
	frames := aClip frames ifNil: [^ nil].
	frames isEmpty ifTrue: [^ nil].
	strips ifNil: [strips := Dictionary new].
	^ strips at: (self stripKeyOf: aClip depth: aDepth) ifAbsentPut: [| width |
		width := view pixelsPerSecond * view metersPerPixel / aClip rate.
		(1 to: frames size by: self framesPerStrip) asArray collect: [:start |
			SRRedawLatentStrip
				frames: frames
				from: start
				count: (self framesPerStrip min: frames size - start + 1)
				frameWidth: width
				depth: aDepth
				projection: (self projectionFor: frames first size)]]
]

{
	#category : #latents,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:34'
}
SRRedawClipsFeature >> style [
	^ style ifNil: [style := SRRedawLatentStyle new]
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
