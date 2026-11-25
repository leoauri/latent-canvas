Class {
	#name : #SRRedawLoadPanelTest,
	#superclass : #TestCase,
	#category : #'Redaw-Tests'
}

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:58'
}
SRRedawLoadPanelTest >> testEachStepSpinsForTheLoad [
	| panel start |
	panel := SRRedawLoadPanel new.
	panel load: 5.
	start := Time utcMicrosecondClock.
	panel step: 0.01.
	self assert: Time utcMicrosecondClock - start >= 5000.
]

{
	#category : #tests,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 17:58'
}
SRRedawLoadPanelTest >> testTheSliderFacesTheCameraTheAlignmentTurnsTo [
	| panel camera slider |
	panel := SRRedawLoadPanel new.
	camera := 1m @ 0 @ 2m.
	panel globalRotation: (panel alignedRotationFor: camera).
	slider := panel instVarNamed: 'slider'.
	self assert: ((slider globalTransform localDirToGlobal: 0 @ 0 @ 1) normalize dot: camera normalized) > 0.99.
	self assert: (slider pressAt: (slider globalTransform localPointToGlobal: slider trackRight @ 0 @ 0)) == #drag.
	self assert: panel load equals: 50.
]
