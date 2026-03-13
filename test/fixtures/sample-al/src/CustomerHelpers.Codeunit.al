codeunit 50101 "Contoso Customer Helpers"
{
    procedure NormalizeName(CustomerName: Text[100]): Text[100]
    begin
        exit(CustomerName.Trim());
    end;
}

