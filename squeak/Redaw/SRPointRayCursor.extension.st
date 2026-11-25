Extension { #name : #SRPointRayCursor }

{
	#category : #'*Redaw-XR',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:06'
}
SRPointRayCursor >> redawRay [
	^ SRRay origin: gogo globalTranslation forward: gogo forward
]
