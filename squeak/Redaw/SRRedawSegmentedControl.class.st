Class {
	#name : #SRRedawSegmentedControl,
	#superclass : #SRObject,
	#instVars : [
		'segments',
		'states'
	],
	#category : #'Redaw-XR'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSegmentedControl class >> width: aNumber options: anArray [
	"anArray holds a {label. isOnBlock. pressBlock} per segment."
	^ self new setWidth: aNumber options: anArray
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSegmentedControl >> grabTarget: anObject [
	super grabTarget: anObject.
	segments do: [:each | each grabTarget: anObject].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSegmentedControl >> height [
	^ 3.6cm
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:39'
}
SRRedawSegmentedControl >> initialize [
	"My segments pass presses up; the panel finds the one under the point."
	super initialize.
	self cursorMode: SRCursorMode ignore.
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSegmentedControl >> pressAt: aGlobalPoint [
	"Answers nil if the point is not on me."
	^ (segments detect: [:each | each redawContains: aGlobalPoint] ifNone: [nil])
		ifNotNil: [:segment |
			segment redawPress.
			#done]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSegmentedControl >> refresh [
	segments with: states do: [:segment :isOn |
		segment slabColor: (isOn value
			ifTrue: [Color r: 0.2 g: 0.5 b: 0.85]
			ifFalse: [Color gray: 0.25])].
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:27'
}
SRRedawSegmentedControl >> setWidth: aNumber options: anArray [
	| count width scale |
	count := anArray size.
	width := aNumber - (count - 1 * self spacing) / count.
	scale := anArray inject: 1.1cm into: [:min :each | min min: width - 1.5cm / (each first size max: 1) / SRRedawSegment characterWidth].
	states := anArray collect: [:each | each second].
	segments := anArray withIndexCollect: [:each :i |
		self addChild: (SRRedawSegment new
			size: width @ self height @ 1.2cm;
			labelScale: scale;
			label: each first;
			action: each third;
			cursorMode: SRCursorMode pass;
			translation: (aNumber / -2 + (width / 2) + (i - 1 * (width + self spacing))) @ 0 @ 0;
			yourself)].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSegmentedControl >> spacing [
	^ 4mm
]
