"
The code changes shared in the session (code.changes) as panes, newest nearest the middle: author, time, who applied it (code.incorporated), intent, and the files or patch.
"
Class {
	#name : #SRRedawCodeChangesFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'changes',
		'applied',
		'browser',
		'panel'
	],
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
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> browser [
	^ browser
]

{
	#category : #browser,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> deactivate [
	| window |
	panel ifNil: [^ self].
	window := panel morph.
	panel remove.
	window ifNotNil: [window delete].
	panel := nil.
	browser := nil.
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> initialize [
	super initialize.
	changes := #().
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> layout [
	panel ifNil: [self openPanel].
	browser changes: changes applied: applied.
]

{
	#category : #browser,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> openPanel [
	| window |
	browser := RedawCodeChangesBrowser new.
	window := SRMorphPanel withoutAddingToWorldDo: [
		ToolBuilder open: browser.
		browser dependents detect: [:each | each isSystemWindow]].
	window extent: (self panelSize * SRMorphPanel defaultPixelsPerMeter) rounded.
	panel := SRMorphPanel new morph: window; yourself.
	self addChild: panel.
	self placeInFrontOfPlayer: panel sideways: 45cm up: -5cm.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> panel [
	^ panel
]

{
	#category : #browser,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> panelSize [
	"In metres."
	^ 1.4 @ 0.9
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> relayout [
	"Not cleared as other features are: the browser is the user's to move."
	[self layout] on: Error do: [:e | lastError := e]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:03'
}
SRRedawCodeChangesFeature >> update [
	| code new newApplied |
	code := (self session document ifNil: [^ false]) at: 'code' ifAbsent: [^ false].
	new := ((code at: 'changes' ifAbsent: [JsonObject new]) values
		asSortedCollection: [:a :b | (a at: 'at' ifAbsent: [0]) >= (b at: 'at' ifAbsent: [0])]) asArray.
	newApplied := code at: 'incorporated' ifAbsent: [JsonObject new].
	(new = changes and: [newApplied = applied]) ifTrue: [^ false].
	changes := new.
	applied := newApplied.
	^ true
]
