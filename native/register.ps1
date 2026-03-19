$HostName = "com.example.time_tracker"
$ManifestPath = "C:\Users\joell\Desktop\tt\native\host-manifest.json"

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\$HostName" `
  /ve /t REG_SZ /d "$ManifestPath" /f

Write-Host "Registered: $HostName -> $ManifestPath"