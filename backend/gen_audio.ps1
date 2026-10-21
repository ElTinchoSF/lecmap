Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile('C:\Users\Usuario\Documents\Martin\DEV\Ingenieria Inversa\backend\samples\teorema_green.wav')
$s.SelectVoiceByHints('Female', 'Spanish')
$s.Speak('Hoy vamos a explicar el teorema de Green. El teorema de Green relaciona una integral de línea sobre una curva cerrada C con una integral doble sobre la región R encerrada por C. La fórmula es integral sobre C de L dx más M dy, igual a integral doble sobre R de la derivada parcial de M respecto a x, menos la derivada parcial de L respecto a y, dx dy. Este teorema es fundamental porque conecta el rotacional de un campo vectorial con la circulación a lo largo de la frontera. Se usa mucho en física para calcular áreas y en mecánica de fluidos.')
$s.Dispose()
Write-Output 'OK'
