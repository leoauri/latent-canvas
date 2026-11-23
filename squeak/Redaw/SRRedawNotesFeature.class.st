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
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> layout [
	(tour ifNil: [#()]) do: [:each | self place: each color: Color white pin: (Color r: 1 g: 0.85 b: 0.2)].
	(chat ifNil: [#()]) do: [:each | | c |
		c := self colorForAuthor: (each at: 'author' ifAbsent: ['?']).
		self place: each color: c pin: c]
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
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawNotesFeature >> place: aNote color: textColor pin: pinColor [
	| m h p |
	m := view metersPerPixel.
	h := view blockHeight.
	p := view localPointFor: (self anchorOf: aNote).
	self addChild: (SRCube new
		color: pinColor;
		ignoreCollision: true;
		scale: (3 * m) @ (3 * m) @ (2 * h);
		translation: p x @ p y @ h;
		yourself).
	self
		addLines: (self linesOf: aNote)
		at: (p x + (6 * m)) @ p y @ (2 * h)
		height: self fontPixels * m
		color: textColor
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
