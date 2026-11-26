Class {
	#name : #RedawTonelChangeTest,
	#superclass : #TestCase,
	#category : #'Redaw-Tests'
}

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChangeTest >> definition: ivars [
	^ 'Class {
	#name : #Foo,
	#instVars : [ ', ivars, ' ],
	#category : #Bar
}

'
]

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChangeTest >> method: aSelector body: aString [
	^ '{
	#category : #accessing
}
Foo >> ', aSelector, ' [
	', aString, '
]

'
]

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChangeTest >> roundTrip: old to: new [
	| edits |
	edits := RedawTonelChange editsFrom: old to: new.
	self assert: (RedawTonelChange apply: edits to: old) = new.
	^ edits
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChangeTest >> testAChangedMethodIsOneEditOfThatMethod [
	| old new edits |
	old := self tonel: {self definition: '''a'''. self method: 'a' body: '^ 1'. self method: 'b' body: '^ 2'}.
	new := self tonel: {self definition: '''a'''. self method: 'a' body: '^ 1'. self method: 'b' body: '^ 3'}.
	edits := self roundTrip: old to: new.
	self assert: edits size = 1.
	self assert: ((edits first at: 'old_str') includesSubstring: 'Foo >> b [').
	self deny: ((edits first at: 'old_str') includesSubstring: 'Foo >> a [').
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChangeTest >> testAMethodAddedFirstGoesWithTheDefinition [
	| old new |
	old := self tonel: {self definition: '''a'''. self method: 'b' body: '^ 2'}.
	new := self tonel: {self definition: '''a'''. self method: 'a' body: '^ 1'. self method: 'b' body: '^ 2'}.
	self assert: (self roundTrip: old to: new) size = 1.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChangeTest >> testARemovedMethodAndANewInstVar [
	| old new edits |
	old := self tonel: {self definition: '''a'''. self method: 'a' body: '^ 1'. self method: 'b' body: '^ 2'}.
	new := self tonel: {self definition: '''a'', ''b'''. self method: 'a' body: '^ 1'}.
	edits := self roundTrip: old to: new.
	self assert: edits size = 2.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChangeTest >> testAnAddedMethodGoesWithTheMethodBeforeIt [
	| old new edits |
	old := self tonel: {self definition: '''a'''. self method: 'a' body: '^ 1'. self method: 'c' body: '^ 3'}.
	new := self tonel: {self definition: '''a'''. self method: 'a' body: '^ 1'. self method: 'b' body: '^ 2'. self method: 'c' body: '^ 3'}.
	edits := self roundTrip: old to: new.
	self assert: edits size = 1.
	self assert: ((edits first at: 'old_str') includesSubstring: 'Foo >> a [').
	self assert: ((edits first at: 'new_str') includesSubstring: 'Foo >> b [').
]

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChangeTest >> tonel: someChunks [
	"A Tonel class file from a definition and method chunks, with LF."
	^ (someChunks inject: '' into: [:a :b | a, b]) withUnixLineEndings
]
