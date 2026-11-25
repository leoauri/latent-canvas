Class {
	#name : #SRRedawSessionViewTest,
	#superclass : #TestCase,
	#instVars : [
		'root',
		'view'
	],
	#category : #'Redaw-Tests'
}

{
	#category : #support,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:02'
}
SRRedawSessionViewTest >> own: anObject as: aName [
	"What #transport and #latentPanel do, without a world."
	root addChild: anObject.
	view instVarNamed: aName put: anObject.
	^ anObject
]

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:02'
}
SRRedawSessionViewTest >> setUp [
	super setUp.
	root := SRObject new.
	view := SRRedawSessionView new.
	root addChild: view.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:02'
}
SRRedawSessionViewTest >> testClosingLeavesOtherObjectsAlone [
	| unrelated otherPanel |
	unrelated := root addChild: SRObject new.
	otherPanel := root addChild: (SRRedawLatentPanel for: SRRedawSessionView new).
	self own: (SRRedawLatentPanel for: view) as: 'latentPanel'.
	view close.
	self assert: unrelated parent == root.
	self assert: otherPanel parent == root.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:02'
}
SRRedawSessionViewTest >> testClosingRemovesTheTransportAndTheLatentPanel [
	| transport panel |
	transport := self own: (SRRedawTransport for: view) as: 'transport'.
	panel := self own: (SRRedawLatentPanel for: view) as: 'latentPanel'.
	view close.
	self deny: (root children includes: view).
	self assert: transport parent isNil.
	self assert: panel parent isNil.
]
