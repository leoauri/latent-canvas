"
Stands in for RedawSession and its RedawPeer: a document in memory, written by path as the peer writes it, so a test never reaches the shared session.
"
Class {
	#name : #SRRedawTestSession,
	#superclass : #Object,
	#instVars : [
		'document',
		'updated'
	],
	#category : #'Redaw-Tests',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession class >> new [
	^ super new initialize
]

{
	#category : #peer,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> at: aPath [
	| node |
	node := document.
	(aPath subStrings: '/') do: [:seg |
		node := (node isKindOf: Dictionary)
			ifTrue: [node at: seg ifAbsent: [^ nil]]
			ifFalse: [(node isKindOf: SequenceableCollection) ifTrue: [node at: seg asNumber + 1 ifAbsent: [^ nil]] ifFalse: [^ nil]]].
	^ node
]

{
	#category : #peer,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> at: aPath put: anObject [
	"As the peer: the parent must exist, '-' appends to a list, and the value is stored as its JSON round trip."
	| segs parent value |
	segs := aPath subStrings: '/'.
	parent := self at: (segs allButLast inject: '' into: [:a :b | a isEmpty ifTrue: [b] ifFalse: [a, '/', b]]).
	segs size = 1 ifTrue: [parent := document].
	value := Json readFrom: (Json render: anObject) readStream.
	(parent isKindOf: Dictionary)
		ifTrue: [parent at: segs last put: value]
		ifFalse: [
			self assert: segs last = '-'.
			parent := self at: (segs allButLast inject: '' into: [:a :b | a isEmpty ifTrue: [b] ifFalse: [a, '/', b]]) put: (parent copyWith: value)].
	updated := updated + 1.
	^ anObject
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> document [
	^ document
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> initialize [
	document := JsonObject new.
	document at: 'state' put: JsonObject new.
	updated := 0.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> isRunning [
	^ true
]

{
	#category : #peer,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> jsonAt: aPath [
	^ (self at: aPath) ifNotNil: [:v | Json render: v]
]

{
	#category : #peer,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> jsonAt: aPath put: aJsonString [
	self at: aPath put: (Json readFrom: aJsonString readStream).
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> name [
	^ 'Squeak'
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> ordered: aCollectionJson [
	^ RedawSession new ordered: aCollectionJson
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> peer [
	^ self
]

{
	#category : #peer,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> removeKey: aPath [
	| segs parentPath parent |
	segs := aPath subStrings: '/'.
	parentPath := segs allButLast inject: '' into: [:a :b | a isEmpty ifTrue: [b] ifFalse: [a, '/', b]].
	parent := self at: parentPath.
	(parent isKindOf: Dictionary)
		ifTrue: [parent removeKey: segs last]
		ifFalse: [self at: parentPath put: (parent copyWithoutIndex: segs last asNumber + 1)].
	updated := updated + 1.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
SRRedawTestSession >> updated [
	^ updated
]
