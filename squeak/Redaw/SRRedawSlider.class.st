Class {
	#name : #SRRedawSlider,
	#superclass : #SRObject,
	#instVars : [
		'width',
		'min',
		'max',
		'logarithmic',
		'integer',
		'getter',
		'setter',
		'printer',
		'down',
		'up',
		'valueField'
	],
	#category : #'Redaw-XR'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider class >> width: aNumber from: min to: max get: getBlock set: setBlock print: printBlock [
	"max may be a block, for a range that changes."
	^ self new setWidth: aNumber from: min to: max get: getBlock set: setBlock print: printBlock
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> addNudge: aString at: x by: anInteger [
	^ self addChild: (SRRedawSegment new
		size: self buttonWidth @ self height @ 1.2cm;
		label: aString;
		slabColor: (Color gray: 0.25);
		action: [self nudge: anInteger];
		cursorMode: SRCursorMode pass;
		translation: x @ 0 @ 0;
		yourself)
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> beInteger [
	integer := true.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> beLogarithmic [
	logarithmic := true.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> buttonWidth [
	^ 4cm
]

{
	#category : #converting,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> fractionAt: aGlobalPoint [
	| x |
	x := (self globalTransform globalPointToLocal: aGlobalPoint) x.
	^ x - self trackLeft / (self trackRight - self trackLeft)
]

{
	#category : #converting,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> fractionOf: aNumber [
	| f |
	f := logarithmic
		ifTrue: [(aNumber / min) ln / (self maximum / min) ln]
		ifFalse: [aNumber - min / (self maximum - min max: 1.0e-9)].
	^ (f max: 0) min: 1
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> grabTarget: anObject [
	super grabTarget: anObject.
	down grabTarget: anObject.
	up grabTarget: anObject.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> height [
	^ 3.6cm
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:39'
}
SRRedawSlider >> initialize [
	"My segments pass presses up; the panel finds the one under the point."
	super initialize.
	self cursorMode: SRCursorMode ignore.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> maximum [
	^ max value
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> nudge: anInteger [
	"Integers step by one, the others by a fortieth of the track."
	setter value: (integer
		ifTrue: [((self value + anInteger) max: min) min: self maximum]
		ifFalse: [self valueAt: (self fractionOf: self value) + (anInteger / 40)]).
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> pressAt: aGlobalPoint [
	"Answers nil if the point is not on me, #drag on the track."
	| local |
	(down redawContains: aGlobalPoint) ifTrue: [down redawPress. ^ #done].
	(up redawContains: aGlobalPoint) ifTrue: [up redawPress. ^ #done].
	local := self globalTransform globalPointToLocal: aGlobalPoint.
	(local y abs <= (self height / 2)
		and: [local x between: self trackLeft - 1cm and: self trackRight + 1cm]) ifFalse: [^ nil].
	self trackAt: aGlobalPoint.
	^ #drag
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> refresh [
	| text |
	text := printer value: self value.
	text = valueField text ifFalse: [valueField text: text].
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> renderOn: aRenderer [
	| base left right knob |
	base := self globalTransform.
	left := self trackLeft.
	right := self trackRight.
	knob := left + (right - left * (self fractionOf: self value)).
	aRenderer
		renderPlainCubeTransformed: base * (Matrix4x4 withOffset: left + right / 2 @ 0 @ 0) * (Matrix4x4 withScale: right - left @ 8mm @ 4mm)
		withColor: (Color gray: 0.4).
	knob > left ifTrue: [
		aRenderer
			renderPlainCubeTransformed: base * (Matrix4x4 withOffset: left + knob / 2 @ 0 @ 1mm) * (Matrix4x4 withScale: knob - left @ 8mm @ 4mm)
			withColor: (Color r: 0.2 g: 0.5 b: 0.85)].
	aRenderer
		renderPlainCubeTransformed: base * (Matrix4x4 withOffset: knob @ 0 @ 3mm) * (Matrix4x4 withScale: 1.4cm @ 3cm @ 1.2cm)
		withColor: (Color gray: 0.9).
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> setWidth: aNumber from: minValue to: maxValue get: getBlock set: setBlock print: printBlock [
	width := aNumber.
	min := minValue.
	max := maxValue.
	getter := getBlock.
	setter := setBlock.
	printer := printBlock.
	logarithmic := false.
	integer := false.
	down := self addNudge: '-' at: width / -2 + (self buttonWidth / 2) by: -1.
	up := self addNudge: '+' at: self trackRight + 1cm + (self buttonWidth / 2) by: 1.
	valueField := self addChild: (SRTextField new
		text: '';
		color: Color white;
		scale: 1.1cm asVector3;
		rotation: SRTextField uprightRotation;
		position: (width / 2 - self valueWidth + 5mm) @ 6mm @ 7mm;
		yourself).
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> trackAt: aGlobalPoint [
	setter value: (self valueAt: (self fractionAt: aGlobalPoint)).
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> trackLeft [
	^ width / -2 + self buttonWidth + 1cm
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> trackRight [
	^ width / 2 - self valueWidth - self buttonWidth - 1cm
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> value [
	^ getter value
]

{
	#category : #converting,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> valueAt: aFraction [
	| f v |
	f := (aFraction max: 0) min: 1.
	v := logarithmic
		ifTrue: [min * ((self maximum / min) raisedTo: f)]
		ifFalse: [min + (self maximum - min * f)].
	^ integer ifTrue: [v rounded] ifFalse: [v]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSlider >> valueWidth [
	^ 9cm
]
