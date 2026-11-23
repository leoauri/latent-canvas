"
The layer stack as panes, back to front from left to right: every field of a layer and its layer function's JavaScript source.
"
Class {
	#name : #SRRedawLayersFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'layers',
		'stack'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #stack,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:52'
}
SRRedawLayersFeature >> deactivate [
	stack ifNil: [^ self].
	stack remove.
	stack := nil.
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:36'
}
SRRedawLayersFeature >> initialize [
	super initialize.
	layers := #().
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:52'
}
SRRedawLayersFeature >> layout [
	stack ifNil: [self openStack].
	stack layers: layers.
]

{
	#category : #stack,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 17:04'
}
SRRedawLayersFeature >> openStack [
	"Panels face along -z, my stack along +z like the other XR objects: turn it round."
	stack := SRRedawLayerStack new view: view; yourself.
	self addChild: stack.
	self placeInFrontOfPlayer: stack sideways: -95cm up: 35cm.
	stack globalRotation: stack globalRotation * (Quaternion angle: 180 axis: Vector3 up).
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:52'
}
SRRedawLayersFeature >> relayout [
	"Not cleared as other features are: the stack is the user's to move."
	[self layout] on: Error do: [:e | lastError := e]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:52'
}
SRRedawLayersFeature >> stack [
	^ stack
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:36'
}
SRRedawLayersFeature >> update [
	| new |
	new := self session layers asArray.
	new = layers ifTrue: [^ false].
	layers := new.
	^ true
]
