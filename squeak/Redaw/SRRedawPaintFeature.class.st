"
Ink strokes on the canvas, kept in the shared document under state/squeak.paint, one entry per stroke id so that peers adding strokes at the same time do not collide. Points are page coordinates (seconds, page y), as the notes use, so the page can draw them too.
"
Class {
	#name : #SRRedawPaintFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'strokes',
		'pending',
		'mine',
		'batch',
		'drawing'
	],
	#category : #'Redaw-Paint',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature class >> key [
	^ 'squeak.paint'
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature class >> path [
	^ 'state/', self key
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> author [
	^ [self session peer name] on: Error do: [:e | 'Squeak']
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> batch [
	^ batch
]

{
	#category : #coordinates,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> canvasPointAt: seconds y: pageY [
	| p |
	p := view localPointFor: (view pagePointAt: seconds y: pageY).
	^ p x @ p y
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> colorOf: aStroke [
	^ [Color fromString: (aStroke at: 'color' ifAbsent: ['#ffffff'])] on: Error do: [:e | Color white]
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> commit: somePoints width: aNumber color: aColor [
	"Shown at once from pending; the document's copy takes over once the session has merged it."
	| flat stroke |
	drawing ifNotNil: [drawing clear].
	somePoints isEmpty ifTrue: [^ nil].
	flat := OrderedCollection new.
	somePoints do: [:p | flat addAll: (self strokePointFor: p)].
	stroke := JsonObject new
		at: 'id' put: 'squeak-', UUID new asString;
		at: 'author' put: self author;
		at: 'color' put: '#', aColor printHtmlString asLowercase;
		at: 'width' put: (aNumber / view metersPerPixel * 10) rounded / 10.0;
		at: 'time' put: DateAndTime now asUnixTime;
		at: 'points' put: flat asArray;
		yourself.
	pending add: stroke.
	mine add: (stroke at: 'id').
	[self write: stroke] on: Error do: [:e | lastError := e].
	self relayout.
	^ stroke
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> draw: aStroke into: aBatch [
	| flat |
	flat := aStroke at: 'points' ifAbsent: [#()].
	aBatch
		addStroke: ((1 to: flat size - 1 by: 2) collect: [:i | self canvasPointAt: (flat at: i) y: (flat at: i + 1)])
		width: (aStroke at: 'width' ifAbsent: [4]) * view metersPerPixel
		color: (self colorOf: aStroke).
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> drawing [
	^ drawing
]

{
	#category : #document,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> erase: anId [
	| peer path order |
	peer := self session peer.
	path := self class path.
	(peer at: path, '/items/', anId) ifNotNil: [peer removeKey: path, '/items/', anId].
	order := (peer at: path, '/order') ifNil: [#()].
	(order indexOf: anId) > 0 ifTrue: [peer removeKey: path, '/order/', ((order indexOf: anId) - 1) printString].
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> initialize [
	super initialize.
	strokes := #().
	pending := OrderedCollection new.
	mine := OrderedCollection new.
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> layout [
	batch := SRRedawStrokeBatch new translation: 0 @ 0 @ self lift; yourself.
	strokes, pending do: [:each | self draw: each into: batch].
	self addChild: batch.
	drawing := SRRedawStrokeBatch new translation: 0 @ 0 @ (self lift + 1mm); yourself.
	self addChild: drawing.
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> lift [
	"Above the map markers, which reach 1.5 cm."
	^ 2cm
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> showDrawing: somePoints width: aNumber color: aColor [
	drawing ifNil: [^ self].
	drawing clear.
	drawing addStroke: somePoints width: aNumber color: aColor.
]

{
	#category : #coordinates,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> strokePointFor: aCanvasPoint [
	"Seconds and page y, as the notes have them."
	| page |
	page := view pagePointFor: aCanvasPoint.
	^ {(page x / view pixelsPerSecond * 1000) rounded / 1000.0. (page y * 10) rounded / 10.0}
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> strokes [
	"In the document's order, then the ones written here that have not come back yet."
	^ strokes, pending
]

{
	#category : #painting,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> undo [
	"The last stroke painted here that is still there. Other peers' strokes are not touched."
	| id |
	[id isNil and: [mine notEmpty]] whileTrue: [ | last |
		last := mine removeLast.
		(self strokes anySatisfy: [:each | (each at: 'id' ifAbsent: [nil]) = last]) ifTrue: [id := last]].
	id ifNil: [^ nil].
	pending := pending reject: [:each | (each at: 'id') = id].
	strokes := strokes reject: [:each | (each at: 'id' ifAbsent: [nil]) = id].
	[self erase: id] on: Error do: [:e | lastError := e].
	self relayout.
	^ id
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> update [
	| state found |
	state := (self session document ifNil: [^ false]) at: 'state' ifAbsent: [^ false].
	found := (self session ordered: (state at: self class key ifAbsent: [nil])) collect: [:each | each copy].
	(found = strokes and: [batch notNil]) ifTrue: [^ false].
	strokes := found.
	pending := pending reject: [:each | strokes anySatisfy: [:s | (s at: 'id' ifAbsent: [nil]) = (each at: 'id')]].
	^ true
]

{
	#category : #document,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 11:59'
}
SRRedawPaintFeature >> write: aStroke [
	"{items, order} as the page keeps its notes. The container is only created when missing: writing it again would drop the other peers' strokes."
	| peer path |
	peer := self session peer.
	path := self class path.
	(peer jsonAt: path) ifNil: [peer jsonAt: path put: '{"items":{},"order":[]}'].
	peer at: path, '/items/', (aStroke at: 'id') put: aStroke.
	peer at: path, '/order/-' put: (aStroke at: 'id').
]
