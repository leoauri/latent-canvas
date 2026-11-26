Class {
	#name : #SRRedawLayerStackTest,
	#superclass : #TestCase,
	#instVars : [
		'view',
		'stack'
	],
	#category : #'Redaw-Tests'
}

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:14'
}
SRRedawLayerStackTest >> flatToggle [
	^ stack children detect: [:each | each isKindOf: SRActionSign]
]

{
	#category : #helpers,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:08'
}
SRRedawLayerStackTest >> press: aLayerId x: x [
	| row |
	row := (stack instVarNamed: #rows) detect: [:each | each first = aLayerId].
	stack onButtonPress: (SRInputEventButton new
		button: #trigger;
		pressed: true;
		point: (stack globalTransform localPointToGlobal: x @ (row second + row third / 2) @ 0);
		yourself).
]

{
	#category : #running,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:08'
}
SRRedawLayerStackTest >> setUp [
	view := SRRedawSessionView new.
	stack := SRRedawLayerStack new view: view; yourself.
	stack layers: {
		Dictionary newFrom: {'id' -> 'a'. 'name' -> 'Audio input'. 'type' -> 'input'}.
		Dictionary newFrom: {'id' -> 'b'. 'name' -> 'echo'. 'type' -> 'function'}}.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:08'
}
SRRedawLayerStackTest >> testPressingTheSlabDoesNotSwitchVisibility [
	self press: 'b' x: 0.
	self assert: (view isShown: 'b').
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:09'
}
SRRedawLayerStackTest >> testTheCheckboxShowsAHiddenLayer [
	| filled |
	filled := [(stack children select: [:each | (each isKindOf: SRCube) and: [(each scale x - 2.6cm) abs < 0.1mm]]) size].
	self assert: 2 equals: filled value.
	view stack toggleLayer: 'b'.
	stack rebuild.
	self assert: stack lastError isNil.
	self assert: 1 equals: filled value.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:08'
}
SRRedawLayerStackTest >> testTheCheckboxSwitchesOnlyItsLayersVisibility [
	self assert: stack lastError isNil.
	self press: 'a' x: stack checkboxRight - 2cm.
	self deny: (view isShown: 'a').
	self assert: (view isShown: 'b').
	self press: 'a' x: stack checkboxRight - 2cm.
	self assert: (view isShown: 'a').
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:14'
}
SRRedawLayerStackTest >> testTheFlatToggleFlattensAndSpreadsTheStack [
	self assert: 'Flatten' equals: self flatToggle label.
	stack onButtonPress: (SRInputEventButton new
		button: #trigger;
		pressed: true;
		point: self flatToggle globalTranslation;
		yourself).
	self assert: view isFlat.
	self assert: (view isShown: 'a').
	stack rebuild.
	self assert: 'Spread' equals: self flatToggle label.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 19:14'
}
SRRedawLayerStackTest >> testTheFlatToggleFollowsTheCrosscut [
	view stack toggleFlat.
	stack rebuild.
	self assert: 'Spread' equals: self flatToggle label.
	view stack toggleFlat.
	stack rebuild.
	self assert: 'Flatten' equals: self flatToggle label.
]
