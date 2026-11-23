"
The layer stack as panes, back to front from left to right: every field of a layer and its layer function's JavaScript source.
"
Class {
	#name : #SRRedawLayersFeature,
	#superclass : #SRRedawPanesFeature,
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawLayersFeature >> entries [
	| layers |
	layers := self session layers asArray.
	^ layers withIndexCollect: [:layer :index |
		{layer at: 'id' ifAbsent: [index printString].
		 (layer at: 'name' ifAbsent: ['?']), ' (', (layer at: 'type' ifAbsent: ['?']), ')'.
		 self textFor: layer at: index of: layers size}]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawLayersFeature >> side [
	^ -1
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:21'
}
SRRedawLayersFeature >> textFor: aLayer at: anIndex of: aCount [
	^ String streamContents: [:s |
		s nextPutAll: (aLayer at: 'name' ifAbsent: ['?']); cr.
		s nextPutAll: 'layer '; print: anIndex; nextPutAll: ' of '; print: aCount; nextPutAll: ', back to front'; cr; cr.
		(aLayer keys asSortedCollection reject: [:key | #('func' 'name') includes: key]) do: [:key |
			s nextPutAll: key; nextPutAll: ': '; nextPutAll: (self show: (aLayer at: key)); cr].
		(aLayer at: 'func' ifAbsent: [nil]) ifNotNil: [:source |
			s cr; nextPutAll: '---- layer function (JavaScript, run in the browsers) ----'; cr; cr; nextPutAll: source]]
]
