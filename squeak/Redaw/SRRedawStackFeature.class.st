"
The layer stack as translucent sheets above the canvas, one per layer, with their masks; the tour and the chat notes on sheets of their own on top. A crosscut plane at the playhead shows the signal rising through the layers that operate there.
"
Class {
	#name : #SRRedawStackFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'layers',
		'masks',
		'maskIndex',
		'masked',
		'clips',
		'signature',
		'sheets',
		'flow',
		'wave',
		'waveKey',
		'cut',
		'cutGlass',
		'cutGlow',
		'cutKey'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature class >> labelRotation [
	"Standing up, read from the canvas's near edge."
	^ Quaternion angle: 180 axis: Vector3 right
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature class >> menuLabel [
	^ 'Layer sheets'
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> add: aBatch page: aRectangle z: z thickness: t color: aColor [
	| a b |
	a := view localPointFor: aRectangle origin.
	b := view localPointFor: aRectangle corner.
	aBatch at: (a x + b x / 2) @ (a y + b y / 2) @ z extent: (b x - a x) abs @ (b y - a y) abs @ t color: aColor
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> addEdgesTo: aBatch z: z color: aColor [
	"The rims make the sheets readable from the side."
	| w d t |
	w := view canvasExtent x.
	d := view canvasExtent y.
	t := 1.5cm.
	aBatch at: 0 @ (d / 2) @ z extent: w @ t @ t color: aColor.
	aBatch at: 0 @ (d / -2) @ z extent: w @ t @ t color: aColor.
	aBatch at: (w / 2) @ 0 @ z extent: t @ d @ t color: aColor.
	aBatch at: (w / -2) @ 0 @ z extent: t @ d @ t color: aColor
]

{
	#category : #waveform,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> audio [
	^ view featureOf: SRRedawAudioFeature
]

{
	#category : #levels,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> bottomLevel [
	^ self levelAt: 1
]

{
	#category : #crosscut,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> buildCut [
	"Moved along time by followPlayhead; its contents are rebuilt only when what crosses it changes."
	self addChild: (cut := SRObject new).
	cut addChild: (cutGlass := SRRedawBoxBatch new).
	cut addChild: (cutGlow := SRRedawBoxBatch new additive: true; yourself).
	layers doWithIndex: [:layer :i |
		self label: (layer at: 'name' ifAbsent: ['?']) sub: (self subtitleOf: layer) at: (self levelAt: i) color: (self colorOf: layer)].
	self label: 'tour' sub: 'the example tour' at: (self levelOfAnnotation: #tour) color: (Color r: 1 g: 0.85 b: 0.2).
	self label: 'notes' sub: 'chat notes on the timeline' at: (self levelOfAnnotation: #chat) color: Color white.
	cutKey := nil
]

{
	#category : #crosscut,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> buildCutGlassAt: seconds [
	"Where each layer's sheet meets the crosscut: across the whole depth, or only inside the masks this moment passes through."
	| d bounds |
	d := view canvasExtent y.
	bounds := view canvasBounds.
	cutGlass clear.
	cutGlass at: 0 @ 0 @ (self bottomLevel + self topLevel / 2) extent: 4mm @ d @ (self topLevel - self bottomLevel + 10cm) color: (Color white alpha: 0.05).
	layers doWithIndex: [:layer :i | | c z |
		c := (self colorOf: layer) alpha: 0.7.
		z := i = self latentIndex ifTrue: [5mm] ifFalse: [self levelAt: i].
		(self isMasked: layer)
			ifFalse: [cutGlass at: 0 @ 0 @ z extent: 1cm @ d @ 1cm color: c]
			ifTrue: [(self masksOf: layer) do: [:m |
				(seconds between: (m at: 't') and: (m at: 't') + (m at: 'dur')) ifTrue: [
					(self pageRectOf: m) ifNotNil: [:r | | a b |
						a := view localPointFor: r origin.
						b := view localPointFor: r corner.
						cutGlass at: 0 @ (a y + b y / 2) @ z extent: 1cm @ (a y - b y) abs @ 1cm color: c]]]]]
]

{
	#category : #crosscut,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> buildCutGlowAt: seconds clips: activeClips [
	"The signal of each clip under the playhead, rising from the canvas; the output node pulses with its loudness."
	| h top |
	h := view blockHeight.
	top := self levelAt: self outputIndex.
	cutGlow clear.
	cutGlow at: 0 @ (view canvasExtent y / -2 - 6cm) @ (self bottomLevel + self topLevel / 2) extent: 1cm @ 1cm @ (self topLevel - self bottomLevel) color: (Color white alpha: 0.3).
	activeClips do: [:clip | | pageY y |
		pageY := clip y + (view clipHeight / 2).
		y := (view localPointFor: 0 @ pageY) y.
		cutGlow at: 0 @ y @ (h + top / 2) extent: 8mm @ 8mm @ (top - h) color: (Color white alpha: 0.6).
		cutGlow at: 0 @ y @ (h + top / 2) extent: 4cm @ 4cm @ (top - h) color: (Color white alpha: 0.1).
		layers doWithIndex: [:layer :i |
			(i > self latentIndex and: [self operates: layer at: seconds y: pageY]) ifTrue: [ | s c |
				c := self colorOf: layer.
				s := i = self outputIndex
					ifTrue: [5cm + (30cm * ((self soundOf: clip) ifNil: [0] ifNotNil: [:sound | sound amplitudeAt: seconds - clip t]))]
					ifFalse: [7cm].
				cutGlow at: 0 @ y @ (self levelAt: i) extent: s @ s @ 1.5cm color: (c alpha: 0.8).
				cutGlow at: 0 @ y @ (self levelAt: i) extent: 2 * s @ (2 * s) @ 3cm color: (c alpha: 0.15)]]]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> buildFlow [
	"A faint line from every clip up to the output, with a node on each layer that operates on it."
	| h top |
	h := view blockHeight.
	top := self levelAt: self outputIndex.
	clips do: [:clip | | page p |
		page := self clipCenterOf: clip.
		p := view localPointFor: page.
		flow at: p x @ p y @ (h + top / 2) extent: 5mm @ 5mm @ (top - h) color: (Color white alpha: 0.12).
		layers doWithIndex: [:layer :i |
			(i > self latentIndex and: [self operates: layer at: page x / view pixelsPerSecond y: page y])
				ifTrue: [flow at: p x @ p y @ (self levelAt: i) extent: 3cm @ 3cm @ 6mm color: ((self colorOf: layer) alpha: 0.45)]]]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> buildSheets [
	| extent |
	extent := view canvasExtent.
	layers doWithIndex: [:layer :i | | z c |
		c := self colorOf: layer.
		z := i = self latentIndex ifTrue: [5mm] ifFalse: [self levelAt: i].
		i = self latentIndex ifFalse: [
			sheets at: 0 @ 0 @ z extent: extent x @ extent y @ 3mm color: (c alpha: ((self isMasked: layer) ifTrue: [0.03] ifFalse: [0.08]))].
		(self isMasked: layer) ifTrue: [
			(self masksOf: layer) do: [:m | (self pageRectOf: m) ifNotNil: [:r |
				self add: sheets page: r z: z thickness: 8mm color: (c alpha: 0.3)]]].
		self addEdgesTo: sheets z: z color: (c alpha: 0.6)].
	#(#tour #chat) do: [:kind | | z |
		z := self levelOfAnnotation: kind.
		sheets at: 0 @ 0 @ z extent: extent x @ extent y @ 2mm color: (Color white alpha: 0.02).
		self addEdgesTo: sheets z: z color: ((kind == #tour ifTrue: [Color r: 1 g: 0.85 b: 0.2] ifFalse: [Color white]) alpha: 0.45)]
]

{
	#category : #waveform,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> buildWave [
	"The output sheet shows what each clip sounds like, standing up from it: its envelope, two bins per bar."
	| level bin m c |
	wave ifNil: [^ self].
	waveKey := self waveKey.
	wave clear.
	level := self levelAt: self outputIndex.
	bin := SRRedawClipSound envelopeSeconds.
	m := view metersPerPixel.
	c := (self colorOf: (layers at: self outputIndex)) alpha: 0.85.
	clips do: [:clip | (self soundOf: clip) ifNotNil: [:sound | sound envelope ifNotNil: [:env | | y |
		y := (view localPointFor: (self clipCenterOf: clip)) y.
		1 to: env size by: 2 do: [:k | | a x |
			a := (env at: k) max: (env at: (k + 1 min: env size)).
			a > 0.01 ifTrue: [
				x := (view localPointFor: (view pagePointAt: clip t + (k * bin) y: 0)) x.
				wave
					at: x @ y @ (level + (a * 15cm / 2))
					extent: (2 * bin * view pixelsPerSecond * m * 0.8) @ 2cm @ (a * 15cm)
					color: c]]]]]
]

{
	#category : #levels,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> canvasLift [
	self latentIndex > 1 ifFalse: [^ 0].
	^ self latentIndex - 1 * self spacing + 10cm
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> clear [
	super clear.
	sheets := flow := wave := cut := cutGlass := cutGlow := nil.
	waveKey := cutKey := nil
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> clipCenterOf: aClip [
	^ view pagePointAt: aClip t + (aClip duration / 2) y: aClip y + (view clipHeight / 2)
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> colorOf: aLayer [
	^ Color h: (aLayer at: 'hue' ifAbsent: [260]) s: 0.65 v: 1.0
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> deactivate [
	view fitLift.
	(view featureOf: SRRedawNotesFeature) ifNotNil: [:notes | notes relayout]
]

{
	#category : #crosscut,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> followPlayhead [
	| playhead now active key changed |
	(cut isNil or: [view isLaidOut not]) ifTrue: [^ self].
	playhead := view featureOf: SRRedawPlayheadFeature.
	now := playhead ifNil: [0] ifNotNil: [:p | p time].
	cut translation: (view localPointFor: (view pagePointAt: now y: 0)) x @ 0 @ 0.
	active := clips select: [:c | now >= c t and: [now < (c t + c duration)]].
	key := {
		(masks select: [:m | now between: (m at: 't') and: (m at: 't') + (m at: 'dur')]) collect: [:m | m at: 'id' ifAbsent: [nil]].
		active collect: [:c | c id]}.
	changed := key ~= cutKey.
	changed ifTrue: [
		cutKey := key.
		self buildCutGlassAt: now].
	(changed or: [playhead notNil and: [playhead isPlaying]]) ifTrue: [self buildCutGlowAt: now clips: active]
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> initialize [
	super initialize.
	layers := #().
	masks := #().
	maskIndex := Dictionary new.
	masked := Set new.
	clips := #().
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> isMasked: aLayer [
	^ masked includes: (aLayer at: 'id' ifAbsent: [nil])
]

{
	#category : #crosscut,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> label: aString sub: subString at: z color: aColor [
	| y |
	y := view canvasExtent y / -2 - 10cm.
	cut addChild: (SRTextField new
		text: (self plain: aString);
		color: aColor;
		scale: 4cm asVector3;
		rotation: self class labelRotation;
		position: 4cm @ y @ (z + 5cm);
		yourself).
	cut addChild: (SRTextField new
		text: (self plain: subString);
		color: (aColor mixed: 0.6 with: Color white);
		scale: 2.5cm asVector3;
		rotation: self class labelRotation;
		position: 4cm @ y @ (z + 0.5cm);
		yourself)
]

{
	#category : #levels,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> latentIndex [
	| i |
	i := layers findFirst: [:each | (each at: 'type' ifAbsent: [nil]) = 'latent'].
	^ i = 0 ifTrue: [1] ifFalse: [i]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> layout [
	(view isLaidOut and: [layers notEmpty]) ifFalse: [^ self].
	view fitLift.
	self addChild: (sheets := SRRedawBoxBatch new).
	self addChild: (wave := SRRedawBoxBatch new).
	self addChild: (flow := SRRedawBoxBatch new additive: true; yourself).
	self buildSheets; buildFlow; buildWave; buildCut.
	(view featureOf: SRRedawNotesFeature) ifNotNil: [:notes | notes relayout]
]

{
	#category : #levels,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> levelAt: anIndex [
	"Height above the canvas: the latent layer is the canvas itself, the layers behind it lie below."
	^ anIndex - self latentIndex * self spacing
]

{
	#category : #levels,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> levelOfAnnotation: aSymbol [
	layers isEmpty ifTrue: [^ 0].
	^ (self levelAt: layers size) + ((aSymbol == #tour ifTrue: [1] ifFalse: [2]) * self spacing)
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> masksOf: aLayer [
	^ maskIndex at: (aLayer at: 'id' ifAbsent: [nil]) ifAbsent: [#()]
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> operates: aLayer at: seconds y: pageY [
	"As operatesAt() in timeline/layers.js: unmasked layers operate everywhere, masked ones inside the union of their rectangles."
	(self isMasked: aLayer) ifFalse: [^ true].
	^ (self masksOf: aLayer) anySatisfy: [:m |
		(seconds between: (m at: 't') and: (m at: 't') + (m at: 'dur'))
			and: [pageY between: (m at: 'y') and: (m at: 'y') + (m at: 'h')]]
]

{
	#category : #levels,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> outputIndex [
	| i |
	i := layers findFirst: [:each | (each at: 'type' ifAbsent: [nil]) = 'audio-out'].
	^ i = 0 ifTrue: [layers size] ifFalse: [i]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> pageRectOf: aMask [
	"Masks may be stripes reaching to 1e9: clipped to the canvas, nil if outside."
	| bounds r |
	bounds := view canvasBounds.
	r := (view pagePointAt: (aMask at: 't') y: (aMask at: 'y'))
		corner: (view pagePointAt: (aMask at: 't') + (aMask at: 'dur') y: (aMask at: 'y') + (aMask at: 'h')).
	(r intersects: bounds) ifFalse: [^ nil].
	^ r intersect: bounds
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> refresh [
	"The crosscut follows the playhead every frame; waveforms appear as the clips get decoded."
	| changed |
	changed := super refresh.
	[self waveKey = waveKey ifFalse: [self buildWave]] on: Error do: [:e | lastError := e].
	[self followPlayhead] on: Error do: [:e | lastError := e].
	^ changed
]

{
	#category : #waveform,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> soundOf: aClip [
	| audio |
	audio := self audio ifNil: [^ nil].
	^ audio sounds at: (audio keyFor: aClip) ifAbsent: [nil]
]

{
	#category : #levels,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> spacing [
	^ 15cm
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> subtitleOf: aLayer [
	| type where |
	type := aLayer at: 'type' ifAbsent: ['?'].
	where := (self isMasked: aLayer)
		ifTrue: [(self masksOf: aLayer) isEmpty ifTrue: [' - masked to nothing'] ifFalse: [' - masked']]
		ifFalse: [' - everywhere'].
	type = 'audio-in' ifTrue: [^ 'live input, not in the session'].
	type = 'audio-out' ifTrue: [^ 'decoded clips, no effects yet'].
	type = 'latent' ifTrue: [^ 'latent clips: the canvas', where].
	(aLayer at: 'model' ifAbsent: [nil]) ifNotNil: [:model | ^ 'model ', (model at: 'name' ifAbsent: ['?']), where].
	^ (String streamContents: [:s |
		s nextPutAll: 'function'.
		((aLayer at: 'paramValues' ifAbsent: [nil]) ifNil: [#()] ifNotNil: [:values | values associations]) do: [:a |
			s space; nextPutAll: a key; nextPut: $=; nextPutAll: (a value isNumber ifTrue: [(a value printShowingMaxDecimalPlaces: 2)] ifFalse: [a value printString])]]), where
]

{
	#category : #levels,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> topLevel [
	^ self levelOfAnnotation: #chat
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> update [
	| state newLayers newMasks newMasked newClips sig |
	state := (self session document ifNil: [^ false]) at: 'state' ifAbsent: [^ false].
	newLayers := self session layers asArray.
	newMasks := (self session ordered: (state at: 'timeline.layers' ifAbsent: [nil])) asArray.
	newMasked := ((state at: 'timeline.masked' ifAbsent: [nil]) ifNil: [#()] ifNotNil: [:map | map keys]) asSet.
	newClips := self session clips asArray.
	sig := {
		newLayers collect: [:l | #('id' 'name' 'hue' 'type' 'paramValues') collect: [:k | (l at: k ifAbsent: [nil]) copy]].
		newMasks collect: [:m | #('layerId' 't' 'dur' 'y' 'h') collect: [:k | m at: k ifAbsent: [nil]]].
		newMasked asSortedCollection asArray.
		newClips collect: [:c | {c id. c t. c y. c rate. c length}]}.
	sig = signature ifTrue: [^ false].
	signature := sig.
	layers := newLayers.
	masks := newMasks collect: [:m | m copy].
	maskIndex := Dictionary new.
	masks do: [:m | (m at: 'layerId' ifAbsent: [nil]) ifNotNil: [:id |
		maskIndex at: id put: ((maskIndex at: id ifAbsent: [#()]) copyWith: m)]].
	masked := newMasked.
	clips := newClips select: [:c | c t notNil and: [c y notNil]].
	^ true
]

{
	#category : #waveform,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:40'
}
SRRedawStackFeature >> waveKey [
	| audio |
	(wave isNil or: [(audio := self audio) isNil]) ifTrue: [^ nil].
	^ audio sounds count: [:each | each envelope notNil]
]
