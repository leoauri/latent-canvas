"
The code changes shared in the session (code.changes) as panes, newest nearest the middle: author, time, who applied it (code.incorporated), intent, and the files or patch.
"
Class {
	#name : #SRRedawCodeChangesFeature,
	#superclass : #SRRedawPanesFeature,
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #menu,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawCodeChangesFeature class >> menuLabel [
	^ 'Code changes'
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawCodeChangesFeature >> entries [
	| code applied |
	code := (self session document ifNil: [^ #()]) at: 'code' ifAbsent: [^ #()].
	applied := code at: 'incorporated' ifAbsent: [JsonObject new].
	^ ((code at: 'changes' ifAbsent: [JsonObject new]) values
		asSortedCollection: [:a :b | (a at: 'at' ifAbsent: [0]) >= (b at: 'at' ifAbsent: [0])])
			asArray collect: [:change |
				{change at: 'id' ifAbsent: ['?'].
				 change at: 'name' ifAbsent: ['(unnamed)'].
				 self textFor: change applied: (applied at: (change at: 'id' ifAbsent: ['']) ifAbsent: [nil])}]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawCodeChangesFeature >> side [
	^ 1
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawCodeChangesFeature >> textFor: aChange applied: whoOrNil [
	^ String streamContents: [:s |
		s nextPutAll: (aChange at: 'name' ifAbsent: ['(unnamed)']); cr.
		s nextPutAll: (self timeOf: aChange); nextPutAll: '   '; nextPutAll: (aChange at: 'author' ifAbsent: ['?']); cr.
		whoOrNil ifNotNil: [s nextPutAll: 'applied by: '; nextPutAll: (self join: whoOrNil keys asSortedCollection with: ', '); cr].
		(aChange at: 'deps' ifAbsent: [#()]) ifNotEmpty: [:deps | s nextPutAll: 'after: '; nextPutAll: (self join: deps with: ', '); cr].
		s cr; nextPutAll: (aChange at: 'intent' ifAbsent: ['']); cr.
		(aChange at: 'guide' ifAbsent: [nil]) ifNotNil: [:guide | s cr; nextPutAll: 'guide: '; nextPutAll: (self show: guide); cr].
		(aChange at: 'files' ifAbsent: [#()]) do: [:file |
			s cr; nextPutAll: '==== '; nextPutAll: (file at: 'path' ifAbsent: ['?']); nextPutAll: ' ===='; cr; cr.
			s nextPutAll: ((file at: 'source' ifAbsent: ['']) ifNil: ['']); cr].
		(aChange at: 'patch' ifAbsent: [nil]) ifNotNil: [:patch |
			s cr; nextPutAll: '==== patch ===='; cr; cr; nextPutAll: (self show: patch)]]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawCodeChangesFeature >> timeOf: aChange [
	^ (((DateAndTime fromUnixTime: (aChange at: 'at' ifAbsent: [0]) // 1000) printString first: 16)
		copyReplaceAll: 'T' with: ' '), ' UTC'
]
