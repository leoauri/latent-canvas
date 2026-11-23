"
Colours JavaScript (and the JSX and CSS around it) by tokens: keywords, strings, numbers, comments. No parser: a regex literal or a nested template may come out wrong.
"
Class {
	#name : #RedawJsHighlighter,
	#superclass : #Object,
	#instVars : [
		'source'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #class,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:02'
}
RedawJsHighlighter class >> attributesFor: aKind [
	aKind == #comment ifTrue: [^ {TextColor color: (Color gray: 0.5). TextEmphasis italic}].
	aKind == #string ifTrue: [^ {TextColor color: (Color r: 0.1 g: 0.5 b: 0.15)}].
	aKind == #number ifTrue: [^ {TextColor color: (Color r: 0.1 g: 0.35 b: 0.8)}].
	aKind == #keyword ifTrue: [^ {TextColor color: (Color r: 0.6 g: 0.1 b: 0.6). TextEmphasis bold}].
	^ #()
]

{
	#category : #class,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:02'
}
RedawJsHighlighter class >> highlight: aString [
	^ self new highlight: aString
]

{
	#category : #class,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:02'
}
RedawJsHighlighter class >> keywords [
	^ #('async' 'await' 'break' 'case' 'catch' 'class' 'const' 'continue' 'default' 'delete' 'do' 'else' 'export' 'extends' 'false' 'finally' 'for' 'from' 'function' 'if' 'import' 'in' 'instanceof' 'let' 'new' 'null' 'of' 'return' 'static' 'super' 'switch' 'this' 'throw' 'true' 'try' 'typeof' 'undefined' 'var' 'void' 'while' 'yield') asSet
]

{
	#category : #highlighting,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:02'
}
RedawJsHighlighter >> highlight: aString [
	| out i |
	source := aString asString withSqueakLineEndings.
	out := TextStream on: (Text new: source size).
	i := 1.
	[i <= source size] whileTrue: [| token attributes |
		token := self tokenAt: i.
		attributes := self class attributesFor: token second.
		attributes isEmpty
			ifTrue: [out nextPutAll: (source copyFrom: i to: token first)]
			ifFalse: [out withAttributes: attributes do: [out nextPutAll: (source copyFrom: i to: token first)]].
		i := token first + 1].
	^ out contents
]

{
	#category : #highlighting,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:02'
}
RedawJsHighlighter >> stringEndAt: i [
	"Quotes end at the line end, except template literals."
	| quote e c |
	quote := source at: i.
	e := i + 1.
	[e <= source size] whileTrue: [
		c := source at: e.
		c = $\ ifTrue: [e := e + 1] ifFalse: [
			c = quote ifTrue: [^ e].
			(c = Character cr and: [quote ~= $`]) ifTrue: [^ e - 1]].
		e := e + 1].
	^ source size
]

{
	#category : #highlighting,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:02'
}
RedawJsHighlighter >> tokenAt: i [
	"Answer {last index. kind}."
	| c next e |
	c := source at: i.
	next := i < source size ifTrue: [source at: i + 1] ifFalse: [nil].
	(c = $/ and: [next = $/]) ifTrue: [
		^ {(source indexOf: Character cr startingAt: i ifAbsent: [source size + 1]) - 1. #comment}].
	(c = $/ and: [next = $*]) ifTrue: [
		e := source indexOfSubCollection: '*/' startingAt: i + 2 ifAbsent: [source size].
		^ {e + 1 min: source size. #comment}].
	('''"`' includes: c) ifTrue: [^ {self stringEndAt: i. #string}].
	c isDigit ifTrue: [
		e := i.
		[e < source size and: [(source at: e + 1) isAlphaNumeric or: [(source at: e + 1) = $.]]] whileTrue: [e := e + 1].
		^ {e. #number}].
	(c isLetter or: ['_$' includes: c]) ifTrue: [
		e := i.
		[e < source size and: [(source at: e + 1) isAlphaNumeric or: ['_$' includes: (source at: e + 1)]]] whileTrue: [e := e + 1].
		^ {e. ((self class keywords includes: (source copyFrom: i to: e)) ifTrue: [#keyword] ifFalse: [#plain])}].
	e := i.
	[e < source size and: [(source at: e + 1) isSeparator]] whileTrue: [e := e + 1].
	^ {e. #plain}
]
