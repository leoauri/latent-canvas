"
The code changes shared through a redaw document, newest first. Read only.
"
Class {
	#name : #RedawCodeChangesBrowser,
	#superclass : #Model,
	#instVars : [
		'changes',
		'applied',
		'changeIndex',
		'partIndex'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #toolbuilder,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> buildWith: aBuilder [
	| window |
	window := aBuilder pluggableWindowSpec new
		model: self;
		label: #windowTitle;
		children: OrderedCollection new;
		yourself.
	window children
		add: (aBuilder pluggableListSpec new
			model: self;
			list: #changeList;
			getIndex: #changeIndex;
			setIndex: #changeIndex:;
			frame: (0 @ 0 corner: 0.27 @ 1);
			yourself);
		add: ((self textSpec: #info in: aBuilder)
			frame: (0.27 @ 0 corner: 1 @ 0.3);
			yourself);
		add: (aBuilder pluggableListSpec new
			model: self;
			list: #partList;
			getIndex: #partIndex;
			setIndex: #partIndex:;
			frame: (0.27 @ 0.3 corner: 1 @ 0.42);
			yourself);
		add: ((self textSpec: #code in: aBuilder)
			font: TextStyle defaultFixedFont;
			frame: (0.27 @ 0.42 corner: 1 @ 1);
			yourself).
	^ aBuilder build: window
]

{
	#category : #'change list',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> changeIndex [
	^ changeIndex
]

{
	#category : #'change list',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> changeIndex: anInteger [
	changeIndex := anInteger.
	partIndex := self parts isEmpty ifTrue: [0] ifFalse: [1].
	self changed: #changeIndex.
	self changedPart.
]

{
	#category : #'change list',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> changeList [
	^ changes collect: [:each |
		(each at: 'name' ifAbsent: ['(unnamed)']), '  - ', (each at: 'author' ifAbsent: ['?'])]
]

{
	#category : #'change list',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> changedPart [
	self changed: #info; changed: #partList; changed: #partIndex; changed: #code.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:04'
}
RedawCodeChangesBrowser >> changes: anArray applied: aJsonObject [
	| selectedId |
	selectedId := self selectedChange ifNotNil: [:change | change at: 'id' ifAbsent: [nil]].
	changes := anArray.
	applied := aJsonObject ifNil: [JsonObject new].
	changeIndex := changes findFirst: [:each | (each at: 'id' ifAbsent: [nil]) = selectedId].
	(changeIndex = 0 and: [changes notEmpty]) ifTrue: [changeIndex := 1].
	partIndex := (partIndex max: 1) min: self parts size.
	self changed: #changeList; changed: #changeIndex; changed: #windowTitle.
	self changedPart.
]

{
	#category : #code,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> code [
	| parts |
	parts := self parts.
	(partIndex between: 1 and: parts size) ifFalse: [^ Text new].
	^ [(parts at: partIndex) second value] on: Error do: [:e | Text fromString: e messageText]
]

{
	#category : #code,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> diffOf: anArray [
	^ Text streamContents: [:s |
		anArray doWithIndex: [:edit :i |
			s withAttribute: (TextColor color: (Color gray: 0.45)) do: [
				s nextPutAll: '@@ edit '; print: i; nextPutAll: ' of '; print: anArray size; nextPutAll: ' @@'; cr].
			self lines: (Text fromString: (edit at: 'old_str' ifAbsent: ['']) withSqueakLineEndings) prefix: '- ' color: (Color r: 0.75 g: 0.1 b: 0.1) on: s.
			self lines: (self highlight: (edit at: 'new_str' ifAbsent: [''])) prefix: '+ ' color: (Color r: 0.1 g: 0.55 b: 0.1) on: s.
			s cr]]
]

{
	#category : #info,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> guideOf: aChange [
	| guide |
	guide := aChange at: 'guide' ifAbsent: [^ nil].
	guide isString ifTrue: [guide := [Json readFrom: guide readStream] on: Error do: [:e | ^ Text fromString: 'Guide: ', guide]].
	^ Text streamContents: [:s |
		s withAttribute: TextEmphasis bold do: [s nextPutAll: 'Guide: '; nextPutAll: (guide at: 'title' ifAbsent: [''])].
		(guide at: 'steps' ifAbsent: [#()]) doWithIndex: [:step :i |
			s cr; print: i; nextPutAll: '. '; nextPutAll: (step at: 'text' ifAbsent: [''])]]
]

{
	#category : #code,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> highlight: aString [
	^ RedawJsHighlighter highlight: (aString ifNil: [''])
]

{
	#category : #info,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> info [
	| change |
	change := self selectedChange ifNil: [^ Text new].
	^ Text streamContents: [:s |
		s withAttribute: TextEmphasis bold do: [s nextPutAll: (change at: 'name' ifAbsent: ['(unnamed)'])].
		s cr; nextPutAll: (self timeOf: change); nextPutAll: '   by '; nextPutAll: (change at: 'author' ifAbsent: ['?']); cr.
		(applied at: (change at: 'id' ifAbsent: ['']) ifAbsent: [nil]) ifNotNil: [:who |
			s nextPutAll: 'applied by '; nextPutAll: (self join: who keys asSortedCollection); cr].
		(change at: 'deps' ifAbsent: [#()]) ifNotEmpty: [:deps | s nextPutAll: 'after '; nextPutAll: (self join: deps); cr].
		(change at: 'intent' ifAbsent: [nil]) ifNotNil: [:intent | s cr; nextPutAll: intent withSqueakLineEndings; cr].
		(self guideOf: change) ifNotNil: [:guide | s cr; nextPutAll: guide]]
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> initialize [
	super initialize.
	changes := #().
	applied := JsonObject new.
	changeIndex := 0.
	partIndex := 0.
]

{
	#category : #info,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> join: aCollection [
	^ String streamContents: [:s | aCollection do: [:each | s nextPutAll: each] separatedBy: [s nextPutAll: ', ']]
]

{
	#category : #code,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> lines: aText prefix: aString color: aColor on: aStream [
	"Old text comes out entirely in aColor, new text keeps its highlighting behind a coloured prefix."
	| start |
	start := 1.
	[start <= aText size] whileTrue: [| end line |
		end := (aText string indexOf: Character cr startingAt: start ifAbsent: [aText size + 1]) - 1.
		line := aText copyFrom: start to: end.
		aStream withAttribute: (TextColor color: aColor) do: [aStream nextPutAll: aString].
		aString first = $-
			ifTrue: [aStream withAttribute: (TextColor color: aColor) do: [aStream nextPutAll: line string]]
			ifFalse: [aStream nextPutAll: line].
		aStream cr.
		start := end + 2]
]

{
	#category : #parts,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> partIndex [
	^ partIndex
]

{
	#category : #parts,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> partIndex: anInteger [
	partIndex := anInteger.
	self changed: #partIndex; changed: #code.
]

{
	#category : #parts,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> partList [
	^ self parts collect: [:each | each first]
]

{
	#category : #parts,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> parts [
	"{label. text} per file the change writes."
	| change |
	change := self selectedChange ifNil: [^ #()].
	^ ((change at: 'files' ifAbsent: [#()]) collect: [:file |
			{(file at: 'path' ifAbsent: ['?']), '   (whole file)'. [self highlight: (file at: 'source' ifAbsent: [''])]}]),
		((change at: 'patch' ifAbsent: [#()]) collect: [:part |
			(part includesKey: 'create')
				ifTrue: [{(part at: 'path' ifAbsent: ['?']), '   (new)'. [self highlight: (part at: 'create')]}]
				ifFalse: [| edits |
					edits := part at: 'edits' ifAbsent: [#()].
					{(part at: 'path' ifAbsent: ['?']), '   (', edits size printString, (edits size = 1 ifTrue: [' edit)'] ifFalse: [' edits)']).
					 [self diffOf: edits]}]])
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> selectedChange [
	^ (changeIndex between: 1 and: changes size) ifTrue: [changes at: changeIndex] ifFalse: [nil]
]

{
	#category : #toolbuilder,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> textSpec: aSelector in: aBuilder [
	^ aBuilder pluggableTextSpec new
		model: self;
		getText: aSelector;
		setText: nil;
		readOnly: true;
		askBeforeDiscardingEdits: false;
		indicateUnacceptedChanges: false;
		yourself
]

{
	#category : #info,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> timeOf: aChange [
	^ [| time |
		time := (DateAndTime fromUnixTime: (aChange at: 'at' ifAbsent: [0]) // 1000) asLocal.
		time asDate printString, ' ', (time asTime print24 first: 5)] on: Error do: [:e | '']
]

{
	#category : #toolbuilder,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
RedawCodeChangesBrowser >> windowTitle [
	^ 'Code changes (', changes size printString, ')'
]
