page 50100 "Contoso Customer List"
{
    PageType = List;
    ApplicationArea = All;
    SourceTable = Customer;

    layout
    {
        area(content)
        {
            repeater(General)
            {
                field("No."; Rec."No.")
                {
                    ApplicationArea = All;
                }
            }
        }
    }
}

