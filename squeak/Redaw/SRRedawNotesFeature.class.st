"
Notes pinned to the timeline at (t, world y): the tour (canvas.notes, yellow pins, stepped through by the page's ""Tour"" pill) and the chat notes (timeline.notes, coloured by author).
"
Class {
	#name : #SRRedawNotesFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'tour',
		'chat'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> anchorOf: aNote [
	^ view pagePointAt: (aNote at: 't' ifAbsent: [0]) y: (aNote at: 'y' ifAbsent: [0])
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> boxOf: aNote [
	^ (self anchorOf: aNote) extent: (self columns * self fontPixels * 0.62) @ ((self linesOf: aNote) size * self fontPixels * self lineSpacing)
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> colorForAuthor: aString [
	^ Color h: (aString hash \\ 360) s: 0.6 v: 1.0
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> columns [
	^ 40
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> fontPixels [
	^ 12
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:39'
}
SRRedawNotesFeature >> layout [
	| tourLevel chatLevel |
	tourLevel := view levelOfAnnotation: #tour.
	chatLevel := view levelOfAnnotation: #chat.
	(tour ifNil: [#()]) do: [:each | self place: each color: Color white pin: (Color r: 1 g: 0.85 b: 0.2) level: tourLevel].
	(chat ifNil: [#()]) do: [:each | | c |
		c := self colorForAuthor: (each at: 'author' ifAbsent: ['?']).
		self place: each color: c pin: c level: chatLevel]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> linesOf: aNote [
	| lines heading |
	lines := OrderedCollection new.
	heading := (aNote at: 'author' ifAbsent: [nil])
		ifNil: [aNote at: 'title' ifAbsent: ['']]
		ifNotNil: [:author | author, ':'].
	(heading isNil or: [heading isEmpty]) ifFalse: [lines add: heading].
	lines addAll: (self wrap: (aNote at: 'text' ifAbsent: ['']) columns: self columns maxLines: 8).
	^ lines
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> notes [
	"The tour first, then the chat notes on the timeline."
	^ (tour ifNil: [#()]), (chat ifNil: [#()])
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> pageBounds [
	| rects |
	rects := (self notes collect: [:each | self boxOf: each]) asArray.
	rects isEmpty ifTrue: [^ nil].
	^ rects allButFirst inject: rects first into: [:a :b | a merge: b]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:53'
}
SRRedawNotesFeature >> place: aNote color: textColor pin: pinColor level: aHeight [
	| m h p lines size top |
	m := view metersPerPixel.
	h := view blockHeight.
	p := view localPointFor: (self anchorOf: aNote).
	lines := self linesOf: aNote.
	size := self fontPixels * m.
	top := (p x + (6 * m)) @ p y @ (aHeight + (2 * h)).
	self addChild: (SRCube new
		color: pinColor;
		ignoreCollision: true;
		scale: (3 * m) @ (3 * m) @ (2 * h);
		translation: p x @ p y @ (aHeight + h);
		yourself).
	self addChild: (self plateFor: lines at: top size: size color: pinColor).
	self
		addLines: lines
		at: top
		height: size
		color: textColor
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 18:53'
}
SRRedawNotesFeature >> plateFor: lines at: aVector3 size: fontSize color: aColor [
	"Raylib glyph quads write depth: without one backing per note, the translucent sheets behind are cut out character by character."
	| pad width height |
	pad := fontSize * 0.5.
	width := ((lines inject: 0 into: [:max :each | max max: each size]) * fontSize * 0.65) + (2 * pad).
	height := (((lines size - 1) max: 0) * fontSize * self lineSpacing) + fontSize + (2 * pad).
	^ SRCube new
		color: ((aColor mixed: 0.15 with: Color black) alpha: 0.85);
		ignoreCollision: true;
		scale: width @ height @ 1mm;
		translation: (aVector3 x - pad + (width / 2)) @ (aVector3 y + pad - (height / 2)) @ (aVector3 z - 2mm);
		yourself
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:42'
}
SRRedawNotesFeature >> tour [
	^ tour
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> update [
	| state newTour newChat |
	state := (self session document ifNil: [^ false]) at: 'state' ifAbsent: [^ false].
	newTour := (self session ordered: (state at: 'canvas.notes' ifAbsent: [nil])) collect: [:each | each copy].
	newChat := (self session ordered: (state at: 'timeline.notes' ifAbsent: [nil])) collect: [:each | each copy].
	(newTour = tour and: [newChat = chat]) ifTrue: [^ false].
	tour := newTour.
	chat := newChat.
	^ true
]
