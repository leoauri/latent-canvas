Class {
	#name : #SRRedawLatentStyle,
	#superclass : #Object,
	#instVars : [
		'colourMode',
		'place',
		'gain',
		'count',
		'ordered',
		'grid',
		'dim',
		'highlight',
		'heightMode',
		'heightScale',
		'minHeight',
		'gap',
		'dims',
		'buffers'
	],
	#category : #'Redaw-XR'
}

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 12:30'
}
SRRedawLatentStyle >> applyTo: aShader stats: aStats [
	self isStacked
		ifTrue: [
			self set: #heightParams of: aShader to: {0. dim. 0. heightScale}.
			self set: #style of: aShader to: {colourMode. 1. gain. count min: aStats dims}]
		ifFalse: [
			self set: #heightParams of: aShader to: {heightMode. dim. heightScale. minHeight}.
			self set: #style of: aShader to: {colourMode. place. gain. count min: aStats dims}].
	self set: #refs of: aShader to: {aStats rmsMax. aStats motionMax. aStats elementRef. aStats elementRef}.
	self set: #style2 of: aShader to: {ordered ifTrue: [1] ifFalse: [0]. grid ifTrue: [1] ifFalse: [0]. dim. highlight ifTrue: [1] ifFalse: [0]}.
	Raylib setShaderValueVShader: aShader internalShader locIndex: (aShader uniformLocAt: #order) value: aStats orderBuffer uniformType: 3 count: 32.
]

{
	#category : #choices,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> colourModes [
	^ #('page colour' 'vector' 'page colour by size' 'one dimension')
]

{
	#category : #choices,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> counts [
	^ #(128 64 32 16 8 4)
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> cycleColour [
	colourMode := colourMode + 1 \\ self colourModes size.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> cycleCount [
	count := self next: count in: self counts.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> cycleGap [
	gap := self next: gap in: self gaps.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> cycleHeight [
	heightMode := heightMode + 1 \\ self heightModes size.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> cyclePlace [
	place := place + 1 \\ self places size.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> dims: anInteger [
	dims := anInteger.
	dim := dim min: anInteger - 1.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> gap [
	^ gap
]

{
	#category : #choices,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> gaps [
	^ #(0 0.15 0.4)
]

{
	#category : #choices,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> heightModes [
	^ #('flat' 'vector length' 'movement' 'one dimension, size' 'one dimension, signed')
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> higher [
	heightScale := heightScale * 1.5 min: 2m.
]

{
	#category : #initialize,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> initialize [
	super initialize.
	colourMode := 1.
	place := 0.
	gain := 1.0.
	count := 128.
	ordered := false.
	grid := false.
	dim := 0.
	highlight := false.
	heightMode := 1.
	heightScale := 8cm.
	minHeight := 3mm.
	gap := 0.15.
	dims := 128.
	buffers := Dictionary new.
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 12:30'
}
SRRedawLatentStyle >> isStacked [
	"Stacked: the dimensions go up the sides of columns of one fixed height."
	^ place = 3
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> lessGain [
	gain := gain / 1.5 max: 0.05.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> lower [
	heightScale := heightScale / 1.5 max: 5mm.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> moreGain [
	gain := gain * 1.5 min: 50.
]

{
	#category : #choices,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> next: aValue in: aCollection [
	^ aCollection at: (aCollection indexOf: aValue) \\ aCollection size + 1
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> nextDim [
	self stepDim: 1.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> nextDims [
	self stepDim: 8.
]

{
	#category : #choices,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 12:30'
}
SRRedawLatentStyle >> places [
	^ #('on top' 'up the sides' 'top and sides' 'stacked up')
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> previousDim [
	self stepDim: -1.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> previousDims [
	self stepDim: -8.
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> set: aName of: aShader to: fourNumbers [
	| buffer |
	buffer := buffers at: aName ifAbsentPut: [ByteArray new: 16].
	fourNumbers doWithIndex: [:each :i | buffer floatAt: i - 1 * 4 + 1 put: each asFloat].
	Raylib setShaderValueShader: aShader internalShader locIndex: (aShader uniformLocAt: aName) value: buffer uniformType: 3.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> stepDim: anInteger [
	dim := dim + anInteger \\ dims.
]

{
	#category : #printing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 12:30'
}
SRRedawLatentStyle >> summaryLines [
	^ {
		'Colour: ', (self colourModes at: colourMode + 1).
		'Height: ', (self isStacked ifTrue: ['fixed, stacked'] ifFalse: [self heightModes at: heightMode + 1]), ', ', (heightScale * 100) rounded printString, ' cm'.
		'Dims: ', count printString, (ordered ifTrue: [' by variance, '] ifFalse: [' in order, ']), (self places at: place + 1).
		'Dim ', dim printString, (highlight ifTrue: [' marked'] ifFalse: ['']), '  gain ', (gain printShowingDecimalPlaces: 2), '  gap ', (gap * 100) rounded printString, '%'}
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> toggleGrid [
	grid := grid not.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> toggleHighlight [
	highlight := highlight not.
]

{
	#category : #controls,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStyle >> toggleOrder [
	ordered := ordered not.
]
