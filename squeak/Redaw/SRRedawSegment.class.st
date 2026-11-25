Class {
	#name : #SRRedawSegment,
	#superclass : #SRActionSign,
	#instVars : [
		'labelScale'
	],
	#category : #'Redaw-XR'
}

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:27'
}
SRRedawSegment class >> characterWidth [
	"Of the label font, per unit of scale, measured on a screenshot. SRTextField>>textWidth assumes 0.8 and centres too far left."
	^ 0.55
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:27'
}
SRRedawSegment >> label: aString [
	| scale |
	scale := self labelScale.
	textField
		text: aString;
		scale: scale asVector3;
		position: (aString size * self class characterWidth * scale / -2) @ (textField textHeight * scale / 2) @ (size z / 2 + 1mm).
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSegment >> labelScale [
	^ labelScale ifNil: [1.1cm]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:24'
}
SRRedawSegment >> labelScale: aNumber [
	labelScale := aNumber.
	self label: textField text.
]
