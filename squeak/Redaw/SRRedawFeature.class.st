"
One part of a redaw session drawn on an SRRedawSessionView's canvas, switched on and off independently (SRRedawSessionView>>enable:, #disable:, #toggle:).

The view asks every feature to #refresh each frame and #relayouts the ones whose content changed. #update reads the session's document, which its own process merges in place: it answers whether what I show changed. #pageBounds lets me grow the canvas. Errors are kept in #lastError: the data is live and written by others, and a debugger in the render process would freeze the world.
"
Class {
	#name : #SRRedawFeature,
	#superclass : #SRObject,
	#instVars : [
		'view',
		'seen',
		'lastError'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:23'
}
SRRedawFeature class >> asciiFor: aCharacter [
	^ (Dictionary newFrom: {16rB7 -> '-'. 16rD7 -> 'x'. 16r2013 -> '-'. 16r2014 -> '-'. 16r2212 -> '-'. 16r2018 -> ''''. 16r2019 -> ''''.
		16r201C -> '"'. 16r201D -> '"'. 16r2026 -> '...'. 16r2192 -> '->'. 16r2190 -> '<-'. 16r25B8 -> '>'. 16r25B6 -> '>'.
		16r2248 -> '~'. 16rB2 -> '2'. 16rB0 -> 'deg'})
			at: aCharacter asInteger ifAbsent: ['?']
]

{
	#category : #menu,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawFeature class >> menuLabel [
	^ (self name allButFirst: 'SRRedaw' size) allButLast: 'Feature' size
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature class >> on: aSessionView [
	^ self new view: aSessionView; yourself
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> addLines: aCollection at: aVector3 height: aNumber color: aColor [
	"Answer the y below the last line. One SRTextField per line: Raylib's 3D text does not break lines."
	| y |
	y := aVector3 y.
	aCollection do: [:line |
		self addChild: (SRTextField new
			text: (self plain: line);
			color: aColor;
			scale: aNumber asVector3;
			rotation: SRTextField uprightRotation;
			position: aVector3 x @ y @ aVector3 z;
			yourself).
		y := y - (aNumber * self lineSpacing)].
	^ y
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawFeature >> boundsOnCanvas [
	"My pageBounds, nil if reading them fails."
	^ [self pageBounds] on: Error do: [:e | lastError := e. nil]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> clear [
	self children copy do: [:each | self removeChild: each]
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawFeature >> deactivate [
	"Sent when the view drops me: release what lives outside the image."
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> invalidate [
	seen := nil
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:23'
}
SRRedawFeature >> join: aCollection with: aSeparator [
	^ String streamContents: [:s |
		aCollection do: [:each | s nextPutAll: each] separatedBy: [s nextPutAll: aSeparator]]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> lastError [
	^ lastError
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> layout [
	^ self subclassResponsibility
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> lineSpacing [
	^ 1.3
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> pageBounds [
	"The page rectangle I cover on the canvas, or nil if I sit beside it."
	^ nil
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> plain: aString [
	"The font has ASCII glyphs only, and the string goes to Raylib as bytes."
	^ String streamContents: [:s |
		aString do: [:c |
			c asInteger < 128
				ifTrue: [s nextPut: ((c = Character tab or: [c = Character cr]) ifTrue: [Character space] ifFalse: [c])]
				ifFalse: [s nextPutAll: (self class asciiFor: c)]]]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> refresh [
	"Answer whether what I show changed."
	| stamp |
	stamp := self session updated.
	(stamp isNil or: [stamp = seen]) ifTrue: [^ false].
	seen := stamp.
	^ [self update] on: Error do: [:e | lastError := e. false]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> relayout [
	"Live session data is not under our control: a bad item must not open a debugger in the render process."
	self clear.
	[self layout] on: Error do: [:e | lastError := e]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> session [
	^ view session
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> update [
	"Read the session; answer whether what I show changed."
	^ self subclassResponsibility
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> view [
	^ view
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawFeature >> view: aSessionView [
	view := aSessionView.
	seen := nil
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawFeature >> wrap: aString columns: columns maxLines: maxLines [
	| lines |
	(aString isNil or: [aString isEmpty]) ifTrue: [^ #()].
	lines := OrderedCollection new.
	aString asString lines do: [:paragraph | | line |
		line := ''.
		(paragraph subStrings: ' ') do: [:word |
			line isEmpty
				ifTrue: [line := word]
				ifFalse: [line size + 1 + word size > columns
					ifTrue: [lines add: line. line := word]
					ifFalse: [line := line, ' ', word]]].
		lines add: line].
	(maxLines notNil and: [lines size > maxLines]) ifTrue: [
		lines := (lines first: maxLines) asOrderedCollection.
		lines addLast: lines removeLast, ' ...'].
	^ lines
]
