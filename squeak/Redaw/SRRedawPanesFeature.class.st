"
Upright XR panes (SRMorphPanel) standing behind the canvas' far edge, one per entry, kept in sync with the document: a pane is added or removed when its entry comes or goes and its text replaced when it changes, but never moved once placed, so panes the user moved stay where they are.

Subclasses answer the entries ({id. title. text}, in order) and the side of the canvas they stand on.
"
Class {
	#name : #SRRedawPanesFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'entries',
		'panes'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #panes,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> closePane: aPane [
	| window |
	window := aPane morph.
	aPane remove.
	window ifNotNil: [window delete]
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> deactivate [
	panes do: [:each | self closePane: each].
	panes removeAll
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> entries [
	"{id. title. text} per pane, in order."
	^ self subclassResponsibility
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> initialize [
	super initialize.
	entries := #().
	panes := Dictionary new
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> layout [
	self syncPanes
]

{
	#category : #panes,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> openPane: anEntry at: anIndex [
	| holder window pane |
	holder := StringHolder new contents: (anEntry at: 3); yourself.
	window := SRMorphPanel withoutAddingToWorldDo: [
		ToolBuilder open: holder label: (self titleFor: anEntry).
		holder dependents detect: [:each | each isSystemWindow]].
	window extent: self paneExtent.
	pane := SRMorphPanel new morph: window; yourself.
	pane
		rotation: (Quaternion angle: 90 axis: Vector3 right) * (Quaternion angle: 180 axis: (Vector3 x: 0 y: 0 z: 1));
		translation: (self paneCenterAt: anIndex).
	self addChild: pane.
	^ pane
]

{
	#category : #panes,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:22'
}
SRRedawPanesFeature >> paneCenterAt: anIndex [
	"In my (the canvas') frame: x along the far edge, y away from the viewer, z up."
	| width first |
	width := self paneSpacing * entries size.
	first := self side < 0
		ifTrue: [0 - 0.5 - width + (self paneSpacing / 2)]
		ifFalse: [0.5 + (self paneSpacing / 2)].
	^ (first + (anIndex - 1 * self paneSpacing)) @ (view canvasExtent y / 2 + 0.6) @ (self paneSize y / 2 + 0.1)
]

{
	#category : #panes,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:22'
}
SRRedawPanesFeature >> paneExtent [
	^ (self paneSize * SRMorphPanel defaultPixelsPerMeter) rounded
]

{
	#category : #panes,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:22'
}
SRRedawPanesFeature >> paneSize [
	"In metres."
	^ 1.0 @ 1.3
]

{
	#category : #panes,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> paneSpacing [
	^ 1.1
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> panes [
	^ panes
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> relayout [
	"Not cleared and rebuilt as other features are: the panes are the user's to move."
	[self syncPanes] on: Error do: [:e | lastError := e]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> show: aJsonValue [
	^ aJsonValue isString
		ifTrue: [aJsonValue]
		ifFalse: [[Json render: aJsonValue] on: Error do: [:e | aJsonValue printString]]
]

{
	#category : #panes,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> show: anEntry in: aPane [
	| holder |
	holder := aPane morph model.
	holder contents = (anEntry at: 3) ifFalse: [
		holder contents: (anEntry at: 3).
		holder changed: #contents].
	aPane morph setLabel: (self titleFor: anEntry)
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> side [
	"-1 for left of the canvas' middle, 1 for right."
	^ self subclassResponsibility
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> syncPanes [
	| ids |
	ids := (entries collect: [:each | each first]) asSet.
	(panes keys reject: [:id | ids includes: id]) do: [:id | self closePane: (panes removeKey: id)].
	entries doWithIndex: [:entry :index |
		(panes at: entry first ifAbsent: [nil])
			ifNil: [panes at: entry first put: (self openPane: entry at: index)]
			ifNotNil: [:pane | self show: entry in: pane]]
]

{
	#category : #panes,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> titleFor: anEntry [
	| title |
	title := self plain: (anEntry at: 2).
	^ title size > 48 ifTrue: [(title first: 45), '...'] ifFalse: [title]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawPanesFeature >> update [
	| new |
	new := self entries asArray.
	new = entries ifTrue: [^ false].
	entries := new.
	^ true
]
